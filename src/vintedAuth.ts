import { chromium, type Browser } from "playwright-chromium";
import { config } from "./config.js";
import { setVintedAccessToken } from "./tokenStore.js";
import { decodeJwtExpiry } from "./vinted.js";
import { performVintedLogin, type LoginOutcome } from "./vintedLoginFlow.js";

const BROWSER_LAUNCH_TIMEOUT_MS = 20_000;

// Chromium headless de Playwright s'identifie par défaut avec un User-Agent contenant
// "HeadlessChrome", que Vinted peut traiter différemment d'un vrai navigateur desktop --
// même User-Agent que celui déjà utilisé pour les requêtes HTTP directes (voir
// BROWSER_HEADERS dans vinted.ts), pour rester cohérent.
const DESKTOP_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Cas réel diagnostiqué (2026-09) : Vinted/Cloudflare renvoie une page de challenge ("Please
// wait... Enable JavaScript and cookies to continue") à la place du formulaire de login,
// faisant échouer performVintedLogin en timeout sur EMAIL_SELECTOR avant même d'atteindre le
// formulaire. Chromium piloté par Playwright expose par défaut `navigator.webdriver = true` et
// se lance avec des flags d'automatisation détectables -- des signaux forts pour les
// heuristiques anti-bot de Cloudflare. Rien ici ne garantit de passer le challenge (Cloudflare
// peut aussi challenger sur réputation d'IP, indépendamment du fingerprint du navigateur), mais
// réduit les signaux les plus évidents sans contrepartie -- best-effort, voir aussi le fallback
// manuel (server.ts POST /token) qui reste nécessaire si Cloudflare persiste à bloquer.
const STEALTH_LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

// Exécuté avant tout script de la page (context.addInitScript) : masque les traces
// d'automatisation les plus vérifiées par les scripts anti-bot (navigator.webdriver, absence
// de plugins/languages réalistes, objet window.chrome manquant sur un vrai Chrome desktop).
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
`;

// Traduit l'issue de performVintedLogin en action concrète (mise à jour du tokenStore) et en
// log clair. Séparée de renewVintedTokenViaLogin pour rester testable sans navigateur réel
// (voir tests/vintedAuth.test.ts) : ne fait que de la logique/logging, aucun I/O navigateur.
export function applyLoginOutcome(outcome: LoginOutcome): void {
  switch (outcome.status) {
    case "success": {
      setVintedAccessToken(outcome.token);
      const expiresAt = decodeJwtExpiry(outcome.token);
      console.log(
        `[vintedAuth] token Vinted renouvelé automatiquement${
          expiresAt !== null ? ` (expire le ${new Date(expiresAt).toISOString()})` : " (expiration non décodable)"
        }`
      );
      return;
    }
    case "captcha_or_2fa":
      // Ne pas boucler dessus : Vinted a explicitement demandé une vérification humaine, la
      // retenter immédiatement ne ferait qu'insister auprès d'un système anti-bot. Le token
      // actuel continue de vivre jusqu'à son expiration naturelle, puis le fallback manuel
      // (POST /token) prend le relais.
      console.warn(
        "[vintedAuth] connexion auto bloquée par Vinted (captcha/2FA détecté), renouvellement manuel nécessaire (voir POST /token)"
      );
      return;
    case "invalid_credentials":
      // Pas de nouvelle tentative avant le prochain cycle programmé (90 min) : retenter en
      // boucle sur un mot de passe refusé est le genre de motif qui fait bannir un compte.
      console.error(
        "[vintedAuth] identifiants VINTED_EMAIL/VINTED_PASSWORD refusés par Vinted -- vérifie .env (aucune nouvelle tentative avant le prochain cycle programmé, pour ne pas risquer un blocage du compte)"
      );
      return;
    case "timeout":
      console.warn(
        "[vintedAuth] connexion auto expirée (page Vinted trop lente, sélecteur introuvable ou navigation bloquée) -- nouvel essai au prochain cycle programmé"
      );
      return;
    case "unknown_error":
      console.error(`[vintedAuth] erreur inattendue pendant la connexion automatique: ${outcome.message}`);
      return;
  }
}

// Lance un vrai navigateur Chromium headless, effectue le login, applique l'issue, puis
// referme systématiquement le navigateur (même en cas d'erreur) -- jamais testé directement en
// unit test (nécessiterait un vrai navigateur) : voir performVintedLogin (testable, logique
// pure) et applyLoginOutcome (testable, logique de mise à jour) pour la partie couverte.
export async function renewVintedTokenViaLogin(): Promise<void> {
  const { vintedEmail: email, vintedPassword: password } = config;
  if (!email || !password) {
    console.log("[vintedAuth] VINTED_EMAIL/VINTED_PASSWORD non configurés -- renouvellement automatique désactivé");
    return;
  }

  console.log("[vintedAuth] tentative de renouvellement automatique du token Vinted...");

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      args: STEALTH_LAUNCH_ARGS,
    });
    // newContext (pas newPage directement) : userAgent ne se règle qu'à la création du
    // contexte côté Playwright, pas après coup sur une page déjà créée. locale/timezoneId/
    // viewport alignés sur un vrai desktop FR -- des valeurs par défaut trop génériques
    // (locale vide, viewport headless standard) sont elles aussi vérifiées par certaines
    // heuristiques anti-bot.
    const context = await browser.newContext({
      userAgent: DESKTOP_CHROME_USER_AGENT,
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
      viewport: { width: 1920, height: 1080 },
    });
    await context.addInitScript(STEALTH_INIT_SCRIPT);
    const page = await context.newPage();
    const outcome = await performVintedLogin(page, email, password);
    applyLoginOutcome(outcome);
  } catch (err) {
    // `err` ne peut contenir `password` que si Playwright lui-même le fait fuiter dans un
    // message d'erreur, ce qu'il ne fait pas pour fill()/click() -- mais on ne loggue par
    // prudence que err.message, jamais les variables email/password de cette fonction.
    console.error("[vintedAuth] échec inattendu du renouvellement automatique:", err);
  } finally {
    await browser?.close().catch(() => {});
  }
}

// 90 minutes ne correspond à aucun motif cron calendaire simple (contrairement à "toutes les
// 10 minutes") -- un setInterval classique est plus direct et plus lisible ici qu'une
// expression cron alambiquée pour arriver au même résultat.
const RENEWAL_INTERVAL_MS = 90 * 60 * 1000;

let renewalTimer: NodeJS.Timeout | null = null;

// `renew` injectable (au lieu d'appeler directement renewVintedTokenViaLogin) pour rester
// testable sans navigateur réel : les tests passent un faux renouvellement et vérifient qu'il
// est bien appelé immédiatement, sans jamais déclencher un vrai login Playwright.
export function startAutoTokenRenewal(
  intervalMs = RENEWAL_INTERVAL_MS,
  renew: () => Promise<void> = renewVintedTokenViaLogin
): void {
  if (!config.vintedEmail || !config.vintedPassword) {
    console.log(
      "[vintedAuth] VINTED_EMAIL/VINTED_PASSWORD non définis -- renouvellement automatique désactivé (fallback: POST /token manuel)"
    );
    return;
  }

  // Appel immédiat au démarrage, EN PLUS du cycle périodique ci-dessous : permet de valider
  // tout de suite qu'un login fonctionne (identifiants valides, sélecteurs Vinted toujours
  // d'actualité...) sans attendre 90 min à chaque test/déploiement. Contrepartie assumée : un
  // login Playwright de plus à chaque redémarrage du process (voir README, section risques).
  renew().catch((err) => console.error("[vintedAuth] erreur au renouvellement immédiat du démarrage:", err));

  renewalTimer = setInterval(() => {
    renew().catch((err) => console.error("[vintedAuth] erreur cycle de renouvellement auto:", err));
  }, intervalMs);

  console.log(
    `[vintedAuth] renouvellement automatique du token Vinted armé (immédiat + toutes les ${Math.round(intervalMs / 60_000)} min)`
  );
}

export function stopAutoTokenRenewal(): void {
  if (renewalTimer !== null) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }
}
