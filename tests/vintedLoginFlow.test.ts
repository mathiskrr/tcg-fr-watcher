import { test } from "node:test";
import assert from "node:assert/strict";
import {
  performVintedLogin,
  type LoginPage,
  type LoginPageCookie,
  type LoginPageResponse,
} from "../src/vintedLoginFlow.js";

function makeMockResponse(status: number, userAgent: string | undefined): LoginPageResponse {
  return {
    status: () => status,
    request: () => ({
      headers: () => (userAgent === undefined ? {} : { "user-agent": userAgent }),
    }),
  };
}

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
  failWaitForSelector?: boolean;
  screenshotCalls?: string[]; // rempli au fil des appels à screenshot(), si fourni
  failScreenshot?: boolean;
  gotoResponse?: LoginPageResponse | null; // par défaut: réponse 200 avec un User-Agent de test
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
    gotoResponse = makeMockResponse(200, "Mock/1.0 Test-Agent"),
  } = options;

  return {
    async goto(_url, _opts) {
      if (failGoto) throw new Error("Timeout 50ms exceeded while navigating");
      return gotoResponse;
    },
    async fill(_selector, _value) {},
    async click(_selector) {},
    async waitForSelector(_selector, _opts) {
      if (failWaitForSelector) throw new Error("Timeout 50ms exceeded while waiting for selector");
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

test("performVintedLogin - [debug] prend une capture à chaque étape clé, dans l'ordre", async () => {
  const screenshotPaths: string[] = [];
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "eyJ.abc.def" }],
    screenshotCalls: screenshotPaths,
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

  assert.deepEqual(outcome, { status: "success", token: "eyJ.abc.def" });
  assert.equal(screenshotPaths.length, 4, "arrivée page, après email, après mot de passe, après clic connexion");
  assert.match(screenshotPaths[0], /vinted-debug-01-arrivee-sur-la-page-\d+\.png$/);
  assert.match(screenshotPaths[1], /vinted-debug-02-apres-email-rempli-\d+\.png$/);
  assert.match(screenshotPaths[2], /vinted-debug-03-apres-mot-de-passe-rempli-\d+\.png$/);
  assert.match(screenshotPaths[3], /vinted-debug-04-apres-clic-connexion-\d+\.png$/);
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

test("performVintedLogin - [debug] logge précisément le sélecteur qui a échoué", async (t) => {
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
    errorSpy.mock.calls.some((c) =>
      /attente du champ email.*input\[name="email"\]/.test(String(c.arguments[0]))
    ),
    "doit nommer précisément l'étape et le sélecteur qui ont échoué"
  );
});

test("performVintedLogin - [debug] logge le statut HTTP et le User-Agent de la réponse de navigation", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-ok" }],
    gotoResponse: makeMockResponse(403, "HeadlessChrome/124.0.0.0"),
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
  assert.ok(messages.some((m) => /statut HTTP de navigation: 403/.test(m)));
  assert.ok(messages.some((m) => /User-Agent envoyé: HeadlessChrome\/124\.0\.0\.0/.test(m)));
});

test("performVintedLogin - [debug] gère une réponse de navigation null sans planter", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-ok" }],
    gotoResponse: null,
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

  assert.deepEqual(outcome, { status: "success", token: "token-ok" });
  assert.ok(logSpy.mock.calls.some((c) => /aucune réponse/.test(String(c.arguments[0]))));
});

test("performVintedLogin - [debug] logge le HTML de la page à l'arrivée, tronqué à 2000 caractères", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const longHtml = `<html>${"x".repeat(3000)}</html>`; // > 2000 caractères
  const page = makeMockPage({ html: longHtml });

  await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS
  );

  const htmlLogMessage = logSpy.mock.calls
    .map((c) => String(c.arguments[0]))
    .find((m) => m.includes("HTML à l'arrivée"));

  assert.ok(htmlLogMessage, "doit logger le HTML à l'arrivée sur la page");
  assert.match(htmlLogMessage, /tronqué, 3013 caractères au total/);
  assert.ok(!htmlLogMessage.includes("x".repeat(2001)), "ne doit jamais logger plus de 2000 caractères de HTML");
});
