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
  failWaitForSelector?: boolean;
}

// Implémente LoginPage à la main (aucune dépendance à playwright-chromium) : c'est tout
// l'intérêt de la séparation avec vintedAuth.ts -- ces tests ne lancent jamais de vrai
// navigateur.
function makeMockPage(options: MockPageOptions = {}): LoginPage {
  const { cookies = [], html = "<html></html>", failGoto = false, failWaitForSelector = false } = options;

  return {
    async goto(_url, _opts) {
      if (failGoto) throw new Error("Timeout 50ms exceeded while navigating");
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

  assert.deepEqual(outcome, { status: "unknown_error", message: "net::ERR_NAME_NOT_RESOLVED" });
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
