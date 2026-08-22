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

// Sous-ensemble commun à LoginPage et LoginFrame -- les CMP de cookies (OneTrust, Didomi...)
// rendent souvent leur bandeau dans un iframe, invisible aux sélecteurs cherchés sur la page
// principale (voir findCookieConsentFrame) : cette interface permet à
// acceptCookieConsentIfPresent de chercher indifféremment sur la page ou dans une frame.
export interface LoginClickTarget {
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  click(selector: string): Promise<void>;
}

export interface LoginFrame extends LoginClickTarget {
  url(): string;
  name(): string;
}

export interface LoginPage extends LoginClickTarget {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  content(): Promise<string>;
  context(): LoginPageContext;
  frames(): LoginFrame[];
}

export type LoginOutcome =
  | { status: "success"; token: string }
  | { status: "captcha_or_2fa" }
  | { status: "invalid_credentials" }
  | { status: "timeout" }
  | { status: "unknown_error"; message: string };

// Cas réel diagnostiqué : "https://www.vinted.fr/member/login" (sans le sous-chemin /email)
// était la cause du "timeout" constaté en prod -- la page ne charge jamais le formulaire
// email/mot de passe à cette URL.
const LOGIN_URL = "https://www.vinted.fr/member/login/email?ref_url=%2F";

// Sélecteurs du formulaire de connexion Vinted -- best-effort : Vinted ne documente pas son
// DOM (pas d'API officielle, voir vinted.ts) et peut le changer sans préavis. S'ils cessent de
// matcher, waitForSelector expire proprement en "timeout" (voir performVintedLogin) plutôt que
// de rester bloqué indéfiniment : le fallback manuel (server.ts POST /token) prend le relais.
// Cas réel diagnostiqué : le champ d'identifiant Vinted est "username" (type="text"), pas
// "email" -- confirmé par dump des attributs <input> de la page (voir historique des commits).
const EMAIL_SELECTOR = 'input[name="username"]';
const PASSWORD_SELECTOR = 'input[name="password"], input[type="password"]';
// Cas réel diagnostiqué : button[type="submit"] seul time out -- plusieurs boutons submit
// coexistent sur la page (dont ceux de la popup OneTrust), Playwright ciblait le mauvais.
// Ajout du texte exact "Continuer" (visible sur le vrai bouton, confirmé par dump des
// attributs <button>) pour lever l'ambiguïté.
const SUBMIT_SELECTOR = 'button[type="submit"]:has-text("Continuer")';

// Relevés à 30s (contre 20s/10s/15s initialement) suite au diagnostic de l'échec "timeout" en
// prod -- gardés à cette valeur plus généreuse par précaution (page Vinted parfois lente).
const NAV_TIMEOUT_MS = 30_000;
const FORM_TIMEOUT_MS = 30_000;
const POST_SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

// Cas réel diagnostiqué : une popup de consentement cookies (RGPD, bandeau en bas avec
// "Accepter tout" / "Cookies requis uniquement" / "Gérer les cookies") bloquait l'accès au
// formulaire de login -- d'où le timeout persistant sur EMAIL_SELECTOR malgré une LOGIN_URL
// correcte. Sélecteurs essayés dans l'ordre en un seul waitForSelector (Playwright : une liste
// séparée par des virgules matche le premier trouvé) :
//   - les sélecteurs CSS par id/classe (OneTrust, motif générique "accept") passent en premier
//     -- rapides, mais fragiles si Vinted change son ID/sa classe.
//   - le moteur "text=" de Playwright (recherche par libellé exact, "i" = insensible à la
//     casse) cible directement "Accepter tout" tel qu'observé sur le bandeau Vinted, sans
//     dépendre de la structure DOM -- plus robuste qu'un sélecteur CSS. Piège à éviter : ne
//     JAMAIS matcher "Cookies requis uniquement" ou "Gérer les cookies" (n'accepteraient pas
//     réellement les cookies), d'où des libellés EXACTS plutôt qu'un simple mot-clé "cookie".
//   - `:has-text()` en filet de sécurité (sous-chaîne, pas exact) si le libellé varie
//     légèrement (espace, ponctuation, majuscule isolée...).
const COOKIE_CONSENT_SELECTOR = [
  "button#onetrust-accept-btn-handler",
  'button[id*="accept" i]',
  `text="Accepter tout"i`,
  `text="Tout accepter"i`,
  `text="J'accepte"i`,
  'button:has-text("Accepter tout")',
  'button:has-text("Tout accepter")',
  `button:has-text("J'accepte")`,
  'button:has-text("Accepter")',
].join(", ");

// Timeout volontairement court : la popup n'apparaît pas systématiquement (dépend des cookies
// déjà présents dans le contexte navigateur) -- ne pas ralentir chaque login de 30s pour un
// scénario qui ne se présente qu'une partie du temps.
const COOKIE_CONSENT_TIMEOUT_MS = 5_000;

// Motifs d'URL des CMP (Consent Management Platform) de cookies les plus courants -- best
// effort, comme le reste des sélecteurs de ce fichier : cible l'iframe qui héberge RÉELLEMENT
// le bandeau, plutôt que de chercher en vain sur le document principal.
const CMP_FRAME_URL_PATTERN = /onetrust|cookiebot|didomi|trustarc|cookielaw|cookie-?consent|privacy-center/i;

function findCookieConsentFrame(page: LoginPage): LoginFrame | null {
  return page.frames().find((frame) => CMP_FRAME_URL_PATTERN.test(frame.url())) ?? null;
}

// Ne lève JAMAIS d'exception : l'absence de popup n'est pas une erreur, et une popup présente
// mais non cliquée avec succès ne doit pas non plus bloquer la suite (best-effort pur).
// Cherche le bouton dans l'iframe du CMP si une frame correspondante est détectée (voir
// findCookieConsentFrame), sinon sur la page principale (cas où le bandeau n'est pas dans un
// iframe, ou CMP non reconnu par CMP_FRAME_URL_PATTERN).
async function acceptCookieConsentIfPresent(page: LoginPage): Promise<void> {
  const cmpFrame = findCookieConsentFrame(page);
  const searchTarget: LoginClickTarget = cmpFrame ?? page;

  if (cmpFrame) {
    console.log(`[vintedLoginFlow] iframe de CMP cookies détectée (url: ${cmpFrame.url()}), recherche dans cette frame`);
  }

  try {
    await searchTarget.waitForSelector(COOKIE_CONSENT_SELECTOR, { timeout: COOKIE_CONSENT_TIMEOUT_MS });
    await searchTarget.click(COOKIE_CONSENT_SELECTOR);
    console.log("[vintedLoginFlow] popup de consentement cookies détectée et acceptée");
  } catch {
    console.log("[vintedLoginFlow] aucune popup de consentement cookies détectée (ou déjà acceptée) -- on continue");
  }
}

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
  try {
    await page.goto(LOGIN_URL, { timeout: navTimeoutMs });
  } catch (err) {
    return classifyStepError("navigation vers la page de login (page.goto)", err);
  }

  await acceptCookieConsentIfPresent(page);

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

  try {
    await page.fill(PASSWORD_SELECTOR, password);
  } catch (err) {
    return classifyStepError(`remplissage du champ mot de passe (sélecteur: ${PASSWORD_SELECTOR})`, err);
  }

  try {
    await page.click(SUBMIT_SELECTOR);
  } catch (err) {
    return classifyStepError(`clic sur le bouton de connexion (sélecteur: ${SUBMIT_SELECTOR})`, err);
  }

  return await waitForOutcome(page, postSubmitTimeoutMs, pollIntervalMs);
}
