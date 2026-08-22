import { tmpdir } from "node:os";
import { join } from "node:path";

// Logique de connexion Vinted, séparée de vintedAuth.ts (qui pilote un vrai navigateur
// Playwright) pour rester testable SANS jamais lancer de navigateur réel : LoginPage est un
// sous-ensemble minimal de l'API Page de Playwright, qu'un vrai objet Page satisfait
// structurellement sans adaptateur, et qu'un mock de test peut implémenter à la main.

export interface LoginPageCookie {
  name: string;
  value: string;
}

export interface LoginPageContext {
  cookies(): Promise<LoginPageCookie[]>;
}

// request()/response() minimalistes : juste de quoi lire le statut HTTP et le User-Agent
// réellement envoyé (voir debugLogArrival) -- pas une interface générale des requêtes réseau.
export interface LoginPageRequest {
  headers(): Record<string, string>;
}

export interface LoginPageResponse {
  status(): number;
  request(): LoginPageRequest;
}

export interface LoginPage {
  // Playwright peut renvoyer `null` (ex: navigation vers une simple ancre) -- géré comme
  // "aucune réponse capturée" plutôt qu'une erreur (voir debugLogArrival).
  goto(url: string, options?: { timeout?: number }): Promise<LoginPageResponse | null>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  context(): LoginPageContext;
  screenshot(options: { path: string }): Promise<unknown>;
}

export type LoginOutcome =
  | { status: "success"; token: string }
  | { status: "captcha_or_2fa" }
  | { status: "invalid_credentials" }
  | { status: "timeout" }
  | { status: "unknown_error"; message: string };

const LOGIN_URL = "https://www.vinted.fr/member/login";

// Sélecteurs du formulaire de connexion Vinted -- best-effort : Vinted ne documente pas son
// DOM (pas d'API officielle, voir vinted.ts) et peut le changer sans préavis. S'ils cessent de
// matcher, waitForSelector expire proprement en "timeout" (voir performVintedLogin) plutôt que
// de rester bloqué indéfiniment : le fallback manuel (server.ts POST /token) prend le relais.
const EMAIL_SELECTOR = 'input[name="email"], input[type="email"]';
const PASSWORD_SELECTOR = 'input[name="password"], input[type="password"]';
const SUBMIT_SELECTOR = 'button[type="submit"]';

// --- DEBUG TEMPORAIRE -------------------------------------------------------------------
// Timeouts relevés à 30s (au lieu de 20s/10s/15s) et captures d'écran à chaque étape clé,
// le temps de diagnostiquer un échec "timeout" constaté en prod (page lente ? sélecteur
// obsolète ? vrai blocage anti-bot ?). À RETIRER (ou au moins redescendre les timeouts et
// désactiver les captures) une fois la cause identifiée -- voir README section
// "Renouvellement automatique du token".
const NAV_TIMEOUT_MS = 30_000;
const FORM_TIMEOUT_MS = 30_000;
const POST_SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const DEBUG_LOGIN_ENABLED = true;

const HTML_LOG_TRUNCATE_LENGTH = 2000;

async function debugScreenshot(page: LoginPage, step: string): Promise<void> {
  if (!DEBUG_LOGIN_ENABLED) return;

  const filePath = join(tmpdir(), `vinted-debug-${step}-${Date.now()}.png`);
  try {
    await page.screenshot({ path: filePath });
    console.log(`[vintedLoginFlow][debug] capture sauvegardée (étape "${step}"): ${filePath}`);
  } catch (err) {
    // Une capture qui échoue ne doit jamais faire échouer le login lui-même -- c'est un outil
    // de diagnostic, pas une étape fonctionnelle.
    console.error(`[vintedLoginFlow][debug] échec de la capture (étape "${step}"):`, err);
  }
}

// Cas réel diagnostiqué : la 1ère capture (arrivée sur la page) était un écran blanc total --
// ces logs permettent de distinguer une VRAIE réponse HTTP (bloquée ou non, avec un statut et
// un HTML exploitables) d'un échec silencieux (page.goto qui n'a rien reçu, response === null).
async function debugLogArrival(page: LoginPage, response: LoginPageResponse | null): Promise<void> {
  if (!DEBUG_LOGIN_ENABLED) return;

  if (response === null) {
    console.log("[vintedLoginFlow][debug] page.goto() n'a renvoyé aucune réponse (response === null)");
  } else {
    const userAgent = response.request().headers()["user-agent"] ?? "(en-tête user-agent absent de la requête)";
    console.log(`[vintedLoginFlow][debug] statut HTTP de navigation: ${response.status()}`);
    console.log(`[vintedLoginFlow][debug] User-Agent envoyé: ${userAgent}`);
  }

  try {
    const html = await page.content();
    const truncated =
      html.length > HTML_LOG_TRUNCATE_LENGTH
        ? `${html.slice(0, HTML_LOG_TRUNCATE_LENGTH)}... (tronqué, ${html.length} caractères au total)`
        : html;
    console.log(`[vintedLoginFlow][debug] HTML à l'arrivée sur la page (${html.length} caractères):\n${truncated}`);
  } catch (err) {
    console.error("[vintedLoginFlow][debug] échec de la lecture du HTML à l'arrivée:", err);
  }
}
// --- FIN DEBUG TEMPORAIRE ----------------------------------------------------------------

const ACCESS_TOKEN_COOKIE_NAME = "access_token_web";

// Motifs observés empiriquement (aucune doc officielle Vinted sur son parcours anti-bot) --
// volontairement larges : un faux positif "captcha détecté" retombe sans risque sur le
// fallback manuel, alors qu'un faux négatif laisserait le module insister sur un vrai captcha.
const CAPTCHA_OR_2FA_PATTERNS = [
  /captcha/i,
  /je ne suis pas un robot/i,
  /confirmez? que vous n'[eê]tes pas un robot/i,
  /v[ée]rification suppl[ée]mentaire/i,
  /code de v[ée]rification/i,
  /two-factor/i,
  /\b2fa\b/i,
];

const INVALID_CREDENTIALS_PATTERNS = [
  /identifiants incorrects/i,
  /email ou mot de passe incorrect/i,
  /mot de passe incorrect/i,
  /invalid credentials/i,
  /wrong (email|password)/i,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Traduit une erreur survenue à une étape précise en LoginOutcome, en loggant PRÉCISÉMENT
// quelle étape (et, le cas échéant, quel sélecteur) a échoué -- avant, un seul try/catch
// global autour de tout le parcours ne permettait pas de savoir si "timeout" venait de la
// navigation, d'un sélecteur introuvable, ou d'autre chose.
function classifyStepError(stepDescription: string, err: unknown): LoginOutcome {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[vintedLoginFlow] échec à l'étape "${stepDescription}": ${message}`);

  if (err instanceof Error && /timeout/i.test(err.message)) {
    return { status: "timeout" };
  }
  return { status: "unknown_error", message: `${stepDescription}: ${message}` };
}

// Attend, après soumission du formulaire, soit le cookie de session (succès), soit un des
// motifs d'erreur ci-dessus dans le HTML de la page -- par sondage (le cookie n'est pas
// observable via waitForSelector, qui ne porte que sur le DOM). "timeout" si aucune des deux
// n'apparaît avant deadlineMs : ni succès ni échec identifié, à retenter au prochain cycle.
async function waitForOutcome(page: LoginPage, deadlineMs: number, pollIntervalMs: number): Promise<LoginOutcome> {
  const start = Date.now();

  while (Date.now() - start < deadlineMs) {
    const cookies = await page.context().cookies();
    const tokenCookie = cookies.find((c) => c.name === ACCESS_TOKEN_COOKIE_NAME);
    if (tokenCookie) {
      return { status: "success", token: tokenCookie.value };
    }

    const html = await page.content();
    if (CAPTCHA_OR_2FA_PATTERNS.some((pattern) => pattern.test(html))) {
      return { status: "captcha_or_2fa" };
    }
    if (INVALID_CREDENTIALS_PATTERNS.some((pattern) => pattern.test(html))) {
      return { status: "invalid_credentials" };
    }

    await sleep(pollIntervalMs);
  }

  console.error(
    `[vintedLoginFlow] échec à l'étape "attente de l'issue post-soumission (cookie ${ACCESS_TOKEN_COOKIE_NAME} ou motif d'erreur connu)": aucun des deux n'est apparu en ${deadlineMs}ms`
  );
  return { status: "timeout" };
}

// navTimeoutMs/formTimeoutMs/postSubmitTimeoutMs/pollIntervalMs exposés (au lieu d'être en
// dur) pour permettre des tests rapides et déterministes sans attendre les vrais délais de
// production (voir tests/vintedLoginFlow.test.ts) -- même logique que retries/delayMsBase
// dans searchVinted (vinted.ts).
// Ne loggue et ne renvoie jamais `password` : seul le statut de l'issue sort de cette
// fonction, jamais les identifiants fournis en entrée.
export async function performVintedLogin(
  page: LoginPage,
  email: string,
  password: string,
  navTimeoutMs = NAV_TIMEOUT_MS,
  formTimeoutMs = FORM_TIMEOUT_MS,
  postSubmitTimeoutMs = POST_SUBMIT_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS
): Promise<LoginOutcome> {
  let arrivalResponse: LoginPageResponse | null;
  try {
    arrivalResponse = await page.goto(LOGIN_URL, { timeout: navTimeoutMs });
  } catch (err) {
    return classifyStepError("navigation vers la page de login (page.goto)", err);
  }
  await debugLogArrival(page, arrivalResponse);
  await debugScreenshot(page, "01-arrivee-sur-la-page");

  try {
    await page.waitForSelector(EMAIL_SELECTOR, { timeout: formTimeoutMs });
  } catch (err) {
    return classifyStepError(`attente du champ email (sélecteur: ${EMAIL_SELECTOR})`, err);
  }

  try {
    await page.fill(EMAIL_SELECTOR, email);
  } catch (err) {
    return classifyStepError(`remplissage du champ email (sélecteur: ${EMAIL_SELECTOR})`, err);
  }
  await debugScreenshot(page, "02-apres-email-rempli");

  try {
    await page.fill(PASSWORD_SELECTOR, password);
  } catch (err) {
    return classifyStepError(`remplissage du champ mot de passe (sélecteur: ${PASSWORD_SELECTOR})`, err);
  }
  await debugScreenshot(page, "03-apres-mot-de-passe-rempli");

  try {
    await page.click(SUBMIT_SELECTOR);
  } catch (err) {
    return classifyStepError(`clic sur le bouton de connexion (sélecteur: ${SUBMIT_SELECTOR})`, err);
  }
  await debugScreenshot(page, "04-apres-clic-connexion");

  return await waitForOutcome(page, postSubmitTimeoutMs, pollIntervalMs);
}
