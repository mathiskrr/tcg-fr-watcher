import { test } from "node:test";
import assert from "node:assert/strict";
import {
  performVintedLogin,
  type LoginPage,
  type LoginPageCookie,
  type LoginFrame,
  type LoginLocator,
} from "../src/vintedLoginFlow.js";

// Timeouts réduits pour que les scénarios "timeout"/sondage restent rapides en test (voir
// commentaire dans vintedLoginFlow.ts sur pourquoi ces valeurs sont exposées en paramètres).
const FAST_NAV_TIMEOUT_MS = 50;
const FAST_FORM_TIMEOUT_MS = 50;
const FAST_POST_SUBMIT_TIMEOUT_MS = 50;
const FAST_POLL_INTERVAL_MS = 10;
const FAST_SUBMIT_READY_DELAY_MS = 0;

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

interface MockLocatorOptions {
  count?: number;
  visible?: boolean;
  disabled?: boolean;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  failScrollIntoView?: boolean;
}

// Implémente LoginLocator à la main -- même principe que makeMockPage : aucun vrai navigateur.
// Par défaut, un bouton bien présent/visible/actionnable (le cas "tout va bien").
function makeMockLocator(options: MockLocatorOptions = {}): LoginLocator {
  const {
    count = 1,
    visible = true,
    disabled = false,
    boundingBox = { x: 0, y: 0, width: 100, height: 40 },
    failScrollIntoView = false,
  } = options;

  return {
    async count() {
      return count;
    },
    async isVisible() {
      return visible;
    },
    async isDisabled() {
      return disabled;
    },
    async boundingBox() {
      return boundingBox;
    },
    async scrollIntoViewIfNeeded(_opts) {
      if (failScrollIntoView) throw new Error("locator.scrollIntoViewIfNeeded: Timeout 30000ms exceeded");
    },
  };
}

interface MockPageOptions {
  cookies?: LoginPageCookie[];
  html?: string;
  failGoto?: boolean;
  failWaitForSelector?: boolean; // ne s'applique qu'au sélecteur email (voir isEmailSelector)
  cookiePopupPresent?: boolean; // si true, le waitForSelector du consentement cookies "réussit" (sur la page principale)
  clickCalls?: string[]; // rempli au fil des appels à click() sur la page principale, si fourni
  frames?: LoginFrame[]; // iframes de la page, vide par défaut (voir makeMockFrame)
  failSubmitClick?: boolean; // ne s'applique qu'au clic sur le bouton de connexion (voir isSubmitSelector)
  submitLocator?: MockLocatorOptions; // état du Locator renvoyé pour SUBMIT_SELECTOR (voir isSubmitSelector)
  viewportSize?: { width: number; height: number } | null;
}

// Le sélecteur email (EMAIL_SELECTOR) est le seul, dans le code de prod, à contenir ce
// fragment -- permet au mock de distinguer "on attend le champ email" de "on attend le bouton
// de consentement cookies" sans avoir à exporter les constantes internes de vintedLoginFlow.ts.
function isEmailSelector(selector: string): boolean {
  return selector.includes('input[name="username"]');
}

function isSubmitSelector(selector: string): boolean {
  return selector.includes('button[type="submit"]');
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
    cookiePopupPresent = false,
    clickCalls,
    frames = [],
    failSubmitClick = false,
    submitLocator = {},
    viewportSize = { width: 1280, height: 720 },
  } = options;

  return {
    async goto(_url, _opts) {
      if (failGoto) throw new Error("Timeout 50ms exceeded while navigating");
    },
    async fill(_selector, _value) {},
    async click(selector) {
      if (isSubmitSelector(selector) && failSubmitClick) {
        throw new Error("locator.click: Timeout 30000ms exceeded");
      }
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
    frames() {
      return frames;
    },
    locator(selector) {
      return isSubmitSelector(selector) ? makeMockLocator(submitLocator) : makeMockLocator();
    },
    viewportSize() {
      return viewportSize;
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.ok(
    errorSpy.mock.calls.some((c) => /attente du champ email.*input\[name="username"\]/.test(String(c.arguments[0]))),
    "doit nommer précisément l'étape et le sélecteur qui ont échoué"
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-apres-popup-cookies" });
  assert.ok(
    logSpy.mock.calls.some((c) => /consentement cookies détectée et acceptée/.test(String(c.arguments[0]))),
    "doit logger que la popup a été détectée et acceptée"
  );
  // Le clic sur le bouton de consentement doit précéder celui sur le bouton de connexion.
  assert.equal(clickCalls.length, 2);
  assert.match(clickCalls[0], /accept|cookie/i);
  assert.equal(clickCalls[1], 'button[type="submit"]:has-text("Continuer")');
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-sans-popup" });
  assert.ok(
    logSpy.mock.calls.some((c) => /aucune popup de consentement cookies détectée/.test(String(c.arguments[0]))),
    "doit logger l'absence de popup sans lever d'erreur"
  );
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-via-iframe" });
  assert.ok(
    logSpy.mock.calls.some((c) => /iframe de CMP cookies détectée.*onetrust/i.test(String(c.arguments[0]))),
    "doit logger la détection de l'iframe CMP"
  );
  // Le clic doit avoir eu lieu DANS la frame, jamais sur la page principale.
  assert.equal(frameClickCalls.length, 1);
  assert.match(frameClickCalls[0], /accept|cookie/i);
  assert.deepEqual(
    pageClickCalls,
    ['button[type="submit"]:has-text("Continuer")'],
    "seul le clic sur le bouton de connexion doit passer par la page"
  );
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
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-fallback-page" });
  assert.ok(
    logSpy.mock.calls.some((c) => /consentement cookies détectée et acceptée/.test(String(c.arguments[0]))),
    "doit quand même trouver et cliquer le bouton, sur la page principale cette fois"
  );
});

test("performVintedLogin - clique bien le bouton 'Continuer' précis (pas un des autres boutons submit de la page)", async (t) => {
  const clickCalls: string[] = [];
  const page = makeMockPage({
    cookies: [{ name: "access_token_web", value: "token-bouton-continuer" }],
    clickCalls,
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-bouton-continuer" });
  assert.deepEqual(clickCalls, ['button[type="submit"]:has-text("Continuer")']);
});

test("performVintedLogin - fait défiler le bouton dans la zone visible avant de cliquer", async () => {
  let scrollCalled = false;
  const page: LoginPage = {
    ...makeMockPage({ cookies: [{ name: "access_token_web", value: "token-scroll-ok" }] }),
    locator(selector) {
      return {
        ...makeMockLocator(),
        async scrollIntoViewIfNeeded(_opts) {
          scrollCalled = true;
        },
      };
    },
  };

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.deepEqual(outcome, { status: "success", token: "token-scroll-ok" });
  assert.equal(scrollCalled, true, "scrollIntoViewIfNeeded doit être appelé avant le clic sur le bouton de connexion");
});

test("performVintedLogin - [debug] un clic qui échoue logge l'état du bouton (count/visible/disabled/boundingBox/viewport)", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const page = makeMockPage({
    failSubmitClick: true,
    submitLocator: { count: 1, visible: true, disabled: true, boundingBox: { x: 10, y: 20, width: 120, height: 44 } },
    viewportSize: { width: 1280, height: 720 },
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.equal(outcome.status, "timeout");
  const messages = logSpy.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    messages.some(
      (m) => m.includes("count=1") && m.includes("visible=true") && m.includes("disabled=true") && m.includes('"width":120')
    ),
    "doit logger l'état complet du bouton (count/visible/disabled/boundingBox)"
  );
  assert.ok(messages.some((m) => m.includes('"width":1280')), "doit logger la taille du viewport");
});

test("performVintedLogin - [debug] count=0 (bouton absent) est loggé sans planter", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const page = makeMockPage({
    failSubmitClick: true,
    submitLocator: { count: 0 },
  });

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.equal(outcome.status, "timeout");
  assert.ok(logSpy.mock.calls.some((c) => String(c.arguments[0]).includes("count=0")));
});

test("performVintedLogin - [debug] un échec de lecture de l'état du bouton n'empêche pas la classification normale de l'erreur", async (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  const page: LoginPage = {
    ...makeMockPage({ failSubmitClick: true }),
    locator(_selector) {
      return {
        async count() {
          throw new Error("locator introuvable");
        },
        async isVisible() {
          return false;
        },
        async isDisabled() {
          return false;
        },
        async boundingBox() {
          return null;
        },
        async scrollIntoViewIfNeeded() {},
      };
    },
  };

  const outcome = await performVintedLogin(
    page,
    "user@example.test",
    "hunter2",
    FAST_NAV_TIMEOUT_MS,
    FAST_FORM_TIMEOUT_MS,
    FAST_POST_SUBMIT_TIMEOUT_MS,
    FAST_POLL_INTERVAL_MS,
    FAST_SUBMIT_READY_DELAY_MS
  );

  assert.equal(outcome.status, "timeout");
  assert.ok(
    errorSpy.mock.calls.some((c) => /échec de la lecture de l'état du bouton/.test(String(c.arguments[0]))),
    "l'échec de la lecture doit être loggé, sans empêcher la classification normale de l'erreur"
  );
});
