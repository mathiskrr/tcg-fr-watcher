import { test } from "node:test";
import assert from "node:assert/strict";
import { performVintedLogin, type LoginPage, type LoginPageCookie } from "../src/vintedLoginFlow.js";

// Timeouts réduits pour que les scénarios "timeout"/sondage restent rapides en test (voir
// commentaire dans vintedLoginFlow.ts sur pourquoi ces valeurs sont exposées en paramètres).
const FAST_NAV_TIMEOUT_MS = 50;
const FAST_FORM_TIMEOUT_MS = 50;
const FAST_POST_SUBMIT_TIMEOUT_MS = 50;
const FAST_POLL_INTERVAL_MS = 10;

interface MockPageOptions {
  cookies?: LoginPageCookie[];
  html?: string;
  failGoto?: boolean;
  failWaitForSelector?: boolean; // ne s'applique qu'au sélecteur email (voir isEmailSelector)
  screenshotCalls?: string[]; // rempli au fil des appels à screenshot(), si fourni
  failScreenshot?: boolean;
  cookiePopupPresent?: boolean; // si true, le waitForSelector du consentement cookies "réussit"
  clickCalls?: string[]; // rempli au fil des appels à click(), si fourni
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
      // Sinon : c'est l'attente du bouton de consentement cookies.
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
