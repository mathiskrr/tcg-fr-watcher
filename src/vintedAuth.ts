import { chromium, type Browser } from "playwright-chromium";
import { config } from "./config.js";
import { setVintedAccessToken } from "./tokenStore.js";
import { decodeJwtExpiry } from "./vinted.js";
import { performVintedLogin, type LoginOutcome } from "./vintedLoginFlow.js";

const BROWSER_LAUNCH_TIMEOUT_MS = 20_000;

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
    browser = await chromium.launch({ headless: true, timeout: BROWSER_LAUNCH_TIMEOUT_MS });
    const page = await browser.newPage();
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

export function startAutoTokenRenewal(intervalMs = RENEWAL_INTERVAL_MS): void {
  if (!config.vintedEmail || !config.vintedPassword) {
    console.log(
      "[vintedAuth] VINTED_EMAIL/VINTED_PASSWORD non définis -- renouvellement automatique désactivé (fallback: POST /token manuel)"
    );
    return;
  }

  // Pas d'exécution immédiate au démarrage : un token valide est probablement déjà configuré
  // (VINTED_ACCESS_TOKEN_WEB ou dernier renouvellement manuel/auto) -- inutile de risquer un
  // login Playwright supplémentaire à chaque redémarrage du process.
  renewalTimer = setInterval(() => {
    renewVintedTokenViaLogin().catch((err) => console.error("[vintedAuth] erreur cycle de renouvellement auto:", err));
  }, intervalMs);

  console.log(`[vintedAuth] renouvellement automatique du token Vinted armé (toutes les ${Math.round(intervalMs / 60_000)} min)`);
}

export function stopAutoTokenRenewal(): void {
  if (renewalTimer !== null) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }
}
