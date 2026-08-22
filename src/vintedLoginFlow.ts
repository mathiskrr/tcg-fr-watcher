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

export interface LoginPage {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  context(): LoginPageContext;
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

const NAV_TIMEOUT_MS = 20_000;
const FORM_TIMEOUT_MS = 10_000;
const POST_SUBMIT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

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
  try {
    await page.goto(LOGIN_URL, { timeout: navTimeoutMs });
    await page.waitForSelector(EMAIL_SELECTOR, { timeout: formTimeoutMs });

    await page.fill(EMAIL_SELECTOR, email);
    await page.fill(PASSWORD_SELECTOR, password);
    await page.click(SUBMIT_SELECTOR);

    return await waitForOutcome(page, postSubmitTimeoutMs, pollIntervalMs);
  } catch (err) {
    // Un timeout Playwright (goto/waitForSelector qui expire, ex: page trop lente ou
    // sélecteur introuvable) atterrit ici -- traité comme "timeout" (retenté au prochain
    // cycle) plutôt que remonté tel quel, pour ne pas faire remonter un détail d'implémentation
    // Playwright jusqu'à l'appelant.
    if (err instanceof Error && /timeout/i.test(err.message)) {
      return { status: "timeout" };
    }
    return { status: "unknown_error", message: err instanceof Error ? err.message : String(err) };
  }
}
