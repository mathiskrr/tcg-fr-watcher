import { test } from "node:test";
import assert from "node:assert/strict";
import { performVintedLogin, type LoginPage, type LoginPageCookie, type LoginFrame } from "../src/vintedLoginFlow.js";

// Timeouts réduits pour que les scénarios "timeout"/sondage restent rapides en test (voir
// commentaire dans vintedLoginFlow.ts sur pourquoi ces valeurs sont exposées en paramètres).
const FAST_NAV_TIMEOUT_MS = 50;
const FAST_FORM_TIMEOUT_MS = 50;
const FAST_POST_SUBMIT_TIMEOUT_MS = 50;
const FAST_POLL_INTERVAL_MS = 10;

interface MockFrameOptions {
  url: string;
  name?: string;
  hasConsentButton?: boolean;
  clickCalls?: string[];
}

// Implémente LoginFrame à la main -- même principe que makeMockPage : aucun vrai navigateur.
function makeMockFrame(options: MockFrameOptions): LoginFrame {
  const { url, name = "", hasConsentButton = false, clickCalls } = options;

  return {
    url: () => url,
    name: () => name,
    async waitForSelector(_selector, _opts) {
      if (!hasConsentButton) throw new Error("Timeout 5000ms exceeded while waiting for selector");
    },
    async click(selector) {
      clickCalls?.push(selector);
    },
  };
}

interface MockPageOptions {
  cookies?: LoginPageCookie[];
  html?: string;
  failGoto?: boolean;
  failWaitForSelector?: boolean; // ne s'applique qu'au sélecteur email (voir isEmailSelector)
  screenshotCalls?: string[]; // rempli au fil des appels à screenshot(), si fourni
  failScreenshot?: boolean;
  cookiePopupPresent?: boolean; // si true, le waitForSelector du consentement cookies "réussit" (sur la page principale)
  clickCalls?: string[]; // rempli au fil des appels à click() sur la page principale, si fourni
  frames?: LoginFrame[]; // iframes de la page, vide par défaut (voir makeMockFrame)
  evaluateResult?: unknown; // valeur renvoyée par evaluate(), SANS jamais exécuter la fonction fournie (pas de vrai DOM en test)
}

// Le sélecteur email (EMAIL_SELECTOR) est le seul, dans le code de prod, à contenir ce
// fragment -- permet au mock de distinguer "on attend le champ email" de "on attend le bouton
// de consentement cookies" sans avoir à exporter les constantes internes de vintedLoginFlow.ts.
function isEmailSelector(selector: string): boolean {
  return selector.includes('input[name="email"]');
}

// Implémente LoginPage à la main (aucune dépendance à playwright-chromium) : c'est tout
// l'intérêt de la séparation avec vintedAuth.ts -- ces tests ne lancent jamais de vrai
// navigateur.
function makeMockPage(options: MockPageOptions = {}): LoginPage {
  const {
    cookies = [],
    html = "<html></html>",
    failGoto = false,
    failWaitForSelector = false,
    screenshotCalls,
    failScreenshot = false,
    cookiePopupPresent = false,
    clickCalls,
    frames = [],
    evaluateResult = [],
  } = options;

  return {
    async goto(_url, _opts) {
      if (failGoto) throw new Error("Timeout 50ms exceeded while navigating");
    },
    async fill(_selector, _value) {},
    async click(selector) {
      clickCalls?.push(selector);
    },
    async waitForSelector(selector, _opts) {
      if (isEmailSelector(selector)) {
        if (failWaitForSelector) throw new Error("Timeout 50ms exceeded while waiting for selector");
        return;
      }
      // Sinon : c'est l'attente du bouton de consentement cookies (sur la page principale).
      if (!cookiePopupPresent) throw new Error("Timeout 5000ms exceeded while waiting for selector");
    },
    async content() {
      return html;
    },
    context() {
      return {
        async cookies() {
          return cookies;
        },
      };
    },
    async screenshot({ path }) {
      if (failScreenshot) throw new Error("disque plein");
      screenshotCalls?.push(path);
    },
    frames() {
      return frames;
    },
    // N'exécute JAMAIS `pageFunction` (elle référence `document`, inexistant en Node/test) --
    // renvoie directement la valeur configurée par le test.
    async evaluate<T>(_pageFunction: () => T): Promise<T> {
      return evaluateResult as T;
    },
  };
}

test("performVintedLogin - succès : renvoie le token du cookie access_token_web", async () => {
  const page = makeMockPage({ cookies: [{ name: "access_token_web", value: "eyJ.abc.def" }] });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "eyJ.abc.def" });
});

test("performVintedLogin - ignore un cookie sans rapport et prend le bon par son nom", async () => {
  const page = makeMockPage({
    cookies: [
      { name: "autre_cookie", value: "sans-rapport" },
      { name: "access_token_web", value: "le-bon-token" },
    ],
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "le-bon-token" });
});

test("performVintedLogin - détecte un captcha/2FA dans le HTML de la page", async () => {
  const page = makeMockPage({ html: "<div>Confirmez que vous n'êtes pas un robot</div>" });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "captcha_or_2fa" });
});

test("performVintedLogin - détecte des identifiants refusés dans le HTML de la page", async () => {
  const page = makeMockPage({ html: "<p>Email ou mot de passe incorrect</p>" });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "mauvais-mdp",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "invalid_credentials" });
});

test("performVintedLogin - ni cookie ni motif d'erreur avant le délai -> timeout", async () => {
  const page = makeMockPage({ html: "<html><body>page générique sans rapport</body></html>" });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "timeout" });
});

test("performVintedLogin - un timeout Playwright sur goto() est classé 'timeout'", async () => {
  const page = makeMockPage({ failGoto: true });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "timeout" });
});

test("performVintedLogin - un timeout Playwright sur waitForSelector() est classé 'timeout'", async () => {
  const page = makeMockPage({ failWaitForSelector: true });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "timeout" });
});

test("performVintedLogin - une erreur Playwright non liée à un timeout est classée 'unknown_error'", async () => {
  const page: LoginPage = {
    ...makeMockPage(),
    async goto() {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    },
  };

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, {
    status: "unknown_error",
    message: "navigation vers la page de login (page.goto): net::ERR_NAME_NOT_RESOLVED",
  });
});

test("performVintedLogin - ne fait jamais fuiter le mot de passe dans une erreur 'unknown_error'", async () => {
  const page: LoginPage = {
    ...makeMockPage(),
    async goto() {
      throw new Error("erreur générique sans rapport avec les identifiants");
    },
  };

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "un-mot-de-passe-tres-secret",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.equal(outcome.status, "unknown_error");
  assert.doesNotMatch(JSON.stringify(outcome), /un-mot-de-passe-tres-secret/);
});

test("performVintedLogin - logge précisément l'étape et le sélecteur qui ont échoué", async (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  const page = makeMockPage({ failWaitForSelector: true });

  await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.ok(
    errorSpy.mock.calls.some((c) => /attente du champ email.*input\[name="email"\]/.test(String(c.arguments[0]))),
    "doit nommer précisément l'étape et le sélecteur qui ont échoué"
  );
});

test("performVintedLogin - [debug] prend une capture juste après le chargement, avant la recherche du sélecteur email", async () => {
  const screenshotPaths: string[] = [];
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "eyJ.abc.def" }],
    screenshotCalls: screenshotPaths,
  });

  await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.equal(screenshotPaths.length, 1);
  assert.match(screenshotPaths[0], /vinted-debug-01-apres-chargement-avant-selecteur-email-\d+\.png$/);
});

test("performVintedLogin - [debug] la capture part MÊME quand le sélecteur email n'est jamais trouvé (cas réel diagnostiqué)", async () => {
  const screenshotPaths: string[] = [];
  const page = makeMockPage({ failWaitForSelector: true, screenshotCalls: screenshotPaths });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.equal(outcome.status, "timeout");
  assert.equal(screenshotPaths.length, 1, "la capture doit partir avant l'échec du sélecteur, pas après");
});

test("performVintedLogin - [debug] une capture qui échoue n'empêche pas le login de continuer (best-effort)", async (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-malgre-echec-capture" }],
    failScreenshot: true,
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-malgre-echec-capture" });
  assert.ok(
    errorSpy.mock.calls.some((c) => /échec de la capture/.test(String(c.arguments[0]))),
    "l'échec de la capture doit être loggé, sans jamais interrompre le login"
  );
});

test("performVintedLogin - popup de consentement cookies présente : cliquée, puis le login procède normalement (cas réel diagnostiqué)", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const clickCalls: string[] = [];
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-apres-popup-cookies" }],
    cookiePopupPresent: true,
    clickCalls,
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-apres-popup-cookies" });
  assert.ok(
    logSpy.mock.calls.some((c) => /consentement cookies détectée et acceptée/.test(String(c.arguments[0]))),
    "doit logger que la popup a été détectée et acceptée"
  );
  // Le clic sur le bouton de consentement doit précéder celui sur le bouton de connexion.
  assert.equal(clickCalls.length, 2);
  assert.match(clickCalls[0], /accept|cookie/i);
  assert.equal(clickCalls[1], 'button[type="submit"]');
});

test("performVintedLogin - pas de popup de consentement cookies : aucune erreur, le login procède normalement", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-sans-popup" }],
    cookiePopupPresent: false,
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-sans-popup" });
  assert.ok(
    logSpy.mock.calls.some((c) => /aucune popup de consentement cookies détectée/.test(String(c.arguments[0]))),
    "doit logger l'absence de popup sans lever d'erreur"
  );
});

test("performVintedLogin - [debug] liste tous les iframes de la page (url + name)", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-ok" }],
    frames: [
      makeMockFrame({ url: "https://www.vinted.fr/", name: "" }),
      makeMockFrame({ url: "https://consent.cookiebot.com/some-widget", name: "cookiebot-frame" }),
    ],
  });

  await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  const messages = logSpy.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(messages.some((m) => /2 frame\(s\) détectée\(s\)/.test(m)));
  assert.ok(messages.some((m) => m.includes("https://www.vinted.fr/")));
  assert.ok(messages.some((m) => m.includes("https://consent.cookiebot.com/some-widget") && m.includes("cookiebot-frame")));
});

test("performVintedLogin - popup de consentement dans un iframe CMP (cas réel diagnostiqué) : cherche et clique DANS l'iframe, pas sur la page principale", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const pageClickCalls: string[] = [];
  const frameClickCalls: string[] = [];

  const consentFrame = makeMockFrame({
    url: "https://consent.onetrust.com/some-widget",
    name: "onetrust-consent-frame",
    hasConsentButton: true,
    clickCalls: frameClickCalls,
  });

  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-via-iframe" }],
    // La page principale n'a PAS le bouton (cookiePopupPresent par défaut à false) : seule la
    // frame CMP l'a -- si le code cherchait encore sur la page, ce test échouerait.
    clickCalls: pageClickCalls,
    frames: [consentFrame],
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-via-iframe" });
  assert.ok(
    logSpy.mock.calls.some((c) => /iframe de CMP cookies détectée.*onetrust/i.test(String(c.arguments[0]))),
    "doit logger la détection de l'iframe CMP"
  );
  // Le clic doit avoir eu lieu DANS la frame, jamais sur la page principale.
  assert.equal(frameClickCalls.length, 1);
  assert.match(frameClickCalls[0], /accept|cookie/i);
  assert.deepEqual(pageClickCalls, ['button[type="submit"]'], "seul le clic sur le bouton de connexion doit passer par la page");
});

test("performVintedLogin - un iframe présent mais qui ne correspond à aucun CMP connu : recherche sur la page principale (fallback)", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const unrelatedFrame = makeMockFrame({ url: "https://ads.example.com/banner", name: "ad-frame" });

  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-fallback-page" }],
    cookiePopupPresent: true, // le bouton est sur la page principale, pas dans cette frame non-CMP
    frames: [unrelatedFrame],
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-fallback-page" });
  assert.ok(
    logSpy.mock.calls.some((c) => /consentement cookies détectée et acceptée/.test(String(c.arguments[0]))),
    "doit quand même trouver et cliquer le bouton, sur la page principale cette fois"
  );
});

test("performVintedLogin - [debug] liste les attributs de chaque <input> quand le sélecteur email time out (cas réel diagnostiqué)", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const page = makeMockPage({
    failWaitForSelector: true,
    evaluateResult: [
      { name: null, id: "login-username", type: "text", placeholder: "Adresse e-mail", ariaLabel: null },
      { name: null, id: "login-password", type: "password", placeholder: null, ariaLabel: "Mot de passe" },
    ],
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.equal(outcome.status, "timeout");
  const messages = logSpy.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(messages.some((m) => /2 <input> trouvé\(s\)/.test(m)));
  assert.ok(messages.some((m) => m.includes("login-username") && m.includes("Adresse e-mail")));
  assert.ok(messages.some((m) => m.includes("login-password") && m.includes("Mot de passe")));
});

test("performVintedLogin - [debug] une lecture des <input> qui échoue n'empêche pas la classification normale de l'erreur", async (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  const page: LoginPage = {
    ...makeMockPage({ failWaitForSelector: true }),
    async evaluate() {
      throw new Error("evaluate non disponible");
    },
  };

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  assert.equal(outcome.status, "timeout");
  assert.ok(
    errorSpy.mock.calls.some((c) => /échec de la lecture des <input>/.test(String(c.arguments[0]))),
    "l'échec de la lecture doit être loggé, sans empêcher la classification normale de l'erreur"
  );
});
