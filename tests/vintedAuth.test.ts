import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge (importé transitivement par vintedAuth.js)

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLoginOutcome, startAutoTokenRenewal, stopAutoTokenRenewal } from "../src/vintedAuth.js";
import { getVintedAccessToken, setVintedAccessToken } from "../src/tokenStore.js";
import { config } from "../src/config.js";
import type { LoginOutcome } from "../src/vintedLoginFlow.js";

// Ce fichier n'importe/n'appelle jamais chromium.launch() : applyLoginOutcome et
// startAutoTokenRenewal (chemin désactivé) sont testés sans navigateur réel, comme demandé.
// renewVintedTokenViaLogin (qui pilote un vrai navigateur) n'est volontairement pas testé ici.

test("applyLoginOutcome - succès : met à jour le tokenStore avec le nouveau token", () => {
  applyLoginOutcome({ status: "success", token: "nouveau-token-auto" });

  assert.equal(getVintedAccessToken(), "nouveau-token-auto");
});

test("applyLoginOutcome - succès : logge l'expiration décodée sans jamais logger le token", (t) => {
  const logSpy = t.mock.method(console, "log", () => {});

  // JWT factice avec exp dans 1h.
  const expSeconds = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  const fakeJwt = `${header}.${payload}.sig`;

  applyLoginOutcome({ status: "success", token: fakeJwt });

  assert.equal(logSpy.mock.callCount(), 1);
  const message = String(logSpy.mock.calls[0].arguments[0]);
  assert.match(message, new RegExp(new Date(expSeconds * 1000).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(message, new RegExp(fakeJwt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("applyLoginOutcome - captcha_or_2fa : ne touche pas au tokenStore, logge un avertissement clair", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  setVintedAccessToken("token-avant");

  applyLoginOutcome({ status: "captcha_or_2fa" });

  assert.equal(getVintedAccessToken(), "token-avant", "le token existant ne doit pas être touché");
  assert.equal(warnSpy.mock.callCount(), 1);
  assert.match(String(warnSpy.mock.calls[0].arguments[0]), /captcha\/2FA détecté/);
});

test("applyLoginOutcome - invalid_credentials : ne touche pas au tokenStore, logge une erreur claire", (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  setVintedAccessToken("token-avant-2");

  applyLoginOutcome({ status: "invalid_credentials" });

  assert.equal(getVintedAccessToken(), "token-avant-2");
  assert.equal(errorSpy.mock.callCount(), 1);
  assert.match(String(errorSpy.mock.calls[0].arguments[0]), /identifiants.*refusés/);
});

test("applyLoginOutcome - timeout : ne touche pas au tokenStore, avertit sans être une erreur bloquante", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  setVintedAccessToken("token-avant-3");

  applyLoginOutcome({ status: "timeout" });

  assert.equal(getVintedAccessToken(), "token-avant-3");
  assert.equal(warnSpy.mock.callCount(), 1);
  assert.match(String(warnSpy.mock.calls[0].arguments[0]), /expirée/);
});

test("applyLoginOutcome - unknown_error : logge le message d'erreur, ne touche pas au tokenStore", (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  setVintedAccessToken("token-avant-4");

  const outcome: LoginOutcome = { status: "unknown_error", message: "boom inattendu" };
  applyLoginOutcome(outcome);

  assert.equal(getVintedAccessToken(), "token-avant-4");
  assert.equal(errorSpy.mock.callCount(), 1);
  assert.match(String(errorSpy.mock.calls[0].arguments[0]), /boom inattendu/);
});

test("startAutoTokenRenewal - sans VINTED_EMAIL/VINTED_PASSWORD, n'arme aucun minuteur (désactivé par défaut)", (t) => {
  // config.ts lit process.env UNE SEULE FOIS au chargement du module (pas dynamiquement) :
  // impossible de modifier process.env ici pour simuler l'un ou l'autre cas dans ce test --
  // on vérifie donc le comportement par défaut du dépôt, où tests/env.ts ne définit ni
  // VINTED_EMAIL ni VINTED_PASSWORD (config.vintedEmail/vintedPassword valent déjà null).
  const logSpy = t.mock.method(console, "log", () => {});

  startAutoTokenRenewal();

  assert.ok(
    logSpy.mock.calls.some((c) => /désactivé/.test(String(c.arguments[0]))),
    "doit logger que le renouvellement automatique est désactivé"
  );

  stopAutoTokenRenewal(); // no-op ici (rien n'a été armé) : vérifie surtout que l'appel ne plante pas
});

test("startAutoTokenRenewal - avec identifiants configurés, appelle immédiatement le renouvellement (pas seulement au bout de l'intervalle)", (t) => {
  // config est un objet mutable (pas de migration de données, pas Object.freeze) : on force
  // temporairement des identifiants pour exercer le chemin "activé" sans dépendre de vraies
  // variables d'env, puis on restaure -- comme startAutoTokenRenewal accepte `renew` en
  // injection, ce test ne lance jamais de vrai navigateur (fakeRenew ci-dessous).
  const originalEmail = config.vintedEmail;
  const originalPassword = config.vintedPassword;
  config.vintedEmail = "test@example.test";
  config.vintedPassword = "un-mot-de-passe-de-test";

  let callCount = 0;
  const fakeRenew = async () => {
    callCount++;
  };

  try {
    startAutoTokenRenewal(90 * 60 * 1000, fakeRenew);

    assert.equal(callCount, 1, "doit appeler le renouvellement immédiatement, sans attendre le premier intervalle");
  } finally {
    stopAutoTokenRenewal(); // évite qu'un minuteur de 90 min ne garde le process de test ouvert
    config.vintedEmail = originalEmail;
    config.vintedPassword = originalPassword;
  }
});
