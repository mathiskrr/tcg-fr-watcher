import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge (importé transitivement)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCookieValue,
  fetchAnonymousVintedSession,
  renewVintedTokenAnonymously,
  startAnonymousTokenRenewal,
  stopAnonymousTokenRenewal,
} from "../src/vintedTokenRefresh.js";
import { getVintedAccessToken, setVintedAccessToken, getVintedAnonId, setVintedAnonId } from "../src/tokenStore.js";

// Même helper que tests/vinted.test.ts (non partagé -- ce fichier reste autonome, cohérent avec
// le reste des tests réseau du dépôt qui ne mockent jamais fetch via un utilitaire commun).
async function withMockedFetch<T>(responses: Array<() => Response>, run: () => Promise<T>): Promise<T> {
  let callIndex = 0;
  const original = globalThis.fetch;

  globalThis.fetch = (async () => {
    const factory = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return factory();
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

function responseWithSetCookies(setCookies: string[], anonId?: string): Response {
  const headers = new Headers();
  for (const c of setCookies) headers.append("set-cookie", c);
  if (anonId !== undefined) headers.set("x-anon-id", anonId);
  return new Response(null, { status: 200, headers });
}

test("extractCookieValue - trouve la valeur d'un cookie nommé parmi plusieurs Set-Cookie", () => {
  const headers = [
    "anon_id=abc-123; Path=/; SameSite=lax",
    "access_token_web=le-vrai-token; Domain=.vinted.fr; Path=/; HttpOnly; Secure",
    "refresh_token_web=autre-token; Path=/; HttpOnly",
  ];

  assert.equal(extractCookieValue(headers, "access_token_web"), "le-vrai-token");
});

test("extractCookieValue - une valeur vide (cookie expiré) ne remplace jamais une valeur déjà trouvée", () => {
  // Ordre réel observé empiriquement : la valeur vide (Max-Age=-1, expire l'ancien cookie)
  // PUIS la vraie valeur -- mais le code ne doit pas dépendre de cet ordre précis.
  const headersRealLast = [
    "access_token_web=; Max-Age=-1; Domain=.vinted.fr; Path=/",
    "access_token_web=nouveau-token; Max-Age=604800; Domain=.vinted.fr; Path=/",
  ];
  assert.equal(extractCookieValue(headersRealLast, "access_token_web"), "nouveau-token");

  const headersRealFirst = [
    "access_token_web=nouveau-token; Max-Age=604800; Domain=.vinted.fr; Path=/",
    "access_token_web=; Max-Age=-1; Domain=.vinted.fr; Path=/",
  ];
  assert.equal(extractCookieValue(headersRealFirst, "access_token_web"), "nouveau-token");
});

test("extractCookieValue - cookie absent renvoie null", () => {
  assert.equal(extractCookieValue(["anon_id=abc-123; Path=/"], "access_token_web"), null);
  assert.equal(extractCookieValue([], "access_token_web"), null);
});

test("fetchAnonymousVintedSession - extrait le token depuis les en-têtes Set-Cookie de la réponse", async () => {
  await withMockedFetch(
    [() => responseWithSetCookies(["anon_id=abc-123; Path=/", "access_token_web=frais-et-anonyme; Path=/; HttpOnly"])],
    async () => {
      const session = await fetchAnonymousVintedSession();
      assert.equal(session.token, "frais-et-anonyme");
    }
  );
});

test("fetchAnonymousVintedSession - aucun cookie access_token_web dans la réponse -> token null", async () => {
  await withMockedFetch([() => responseWithSetCookies(["anon_id=abc-123; Path=/"])], async () => {
    const session = await fetchAnonymousVintedSession();
    assert.equal(session.token, null);
  });
});

test("fetchAnonymousVintedSession - extrait X-Anon-Id depuis l'en-tête de réponse", async () => {
  await withMockedFetch(
    [() => responseWithSetCookies(["access_token_web=peu-importe; Path=/"], "anon-id-frais")],
    async () => {
      const session = await fetchAnonymousVintedSession();
      assert.equal(session.anonId, "anon-id-frais");
    }
  );
});

test("fetchAnonymousVintedSession - aucun en-tête x-anon-id dans la réponse -> anonId null", async () => {
  await withMockedFetch([() => responseWithSetCookies(["access_token_web=peu-importe; Path=/"])], async () => {
    const session = await fetchAnonymousVintedSession();
    assert.equal(session.anonId, null);
  });
});

test("renewVintedTokenAnonymously - succès : met à jour le tokenStore (token + anonId) et logge l'expiration décodée", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const expSeconds = Math.floor(Date.now() / 1000) + 3600;
  const fakeJwt = makeFakeJwt({ exp: expSeconds });

  await withMockedFetch(
    [() => responseWithSetCookies([`access_token_web=${fakeJwt}; Path=/; HttpOnly`], "anon-id-du-cycle")],
    async () => {
      await renewVintedTokenAnonymously();
    }
  );

  assert.equal(getVintedAccessToken(), fakeJwt);
  assert.equal(getVintedAnonId(), "anon-id-du-cycle");
  assert.ok(
    logSpy.mock.calls.some((c) => /token Vinted renouvelé anonymement/.test(String(c.arguments[0]))),
    "doit logger le succès du renouvellement du token"
  );
  assert.ok(
    logSpy.mock.calls.some((c) => /X-Anon-Id renouvelé anonymement/.test(String(c.arguments[0]))),
    "doit logger le succès du renouvellement de X-Anon-Id"
  );
  const successLog = String(logSpy.mock.calls.find((c) => /token Vinted renouvelé anonymement/.test(String(c.arguments[0])))?.arguments[0]);
  assert.doesNotMatch(successLog, new RegExp(fakeJwt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "ne doit jamais logger le token lui-même");
});

test("renewVintedTokenAnonymously - aucun cookie reçu : avertit clairement, ne touche pas au token existant", async (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  setVintedAccessToken("token-avant");

  await withMockedFetch([() => responseWithSetCookies([], "anon-id-quand-meme")], async () => {
    await renewVintedTokenAnonymously();
  });

  assert.equal(getVintedAccessToken(), "token-avant", "le token existant ne doit pas être écrasé par un renouvellement raté");
  assert.ok(
    warnSpy.mock.calls.some((c) => /aucun cookie access_token_web reçu/.test(String(c.arguments[0]))),
    "doit avertir clairement de l'absence de cookie"
  );
});

test("renewVintedTokenAnonymously - aucun X-Anon-Id reçu : avertit clairement, ne touche pas à l'anonId existant", async (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  setVintedAnonId("anon-id-avant");

  await withMockedFetch([() => responseWithSetCookies(["access_token_web=peu-importe; Path=/"])], async () => {
    await renewVintedTokenAnonymously();
  });

  assert.equal(getVintedAnonId(), "anon-id-avant", "l'anonId existant ne doit pas être écrasé par un renouvellement raté");
  assert.ok(
    warnSpy.mock.calls.some((c) => /aucun en-tête x-anon-id reçu/.test(String(c.arguments[0]))),
    "doit avertir clairement de l'absence de X-Anon-Id"
  );
});

test("renewVintedTokenAnonymously - erreur réseau : loggée proprement, ne fait jamais planter l'appelant", async (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  setVintedAccessToken("token-avant-erreur");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  try {
    await assert.doesNotReject(renewVintedTokenAnonymously(3, 5));
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(getVintedAccessToken(), "token-avant-erreur");
  assert.ok(
    errorSpy.mock.calls.some((c) => /échec du renouvellement anonyme/.test(String(c.arguments[0]))),
    "doit logger l'échec sans jeter"
  );
});

test("startAnonymousTokenRenewal - appelle immédiatement le renouvellement (pas seulement au bout de l'intervalle)", (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  let callCount = 0;
  const fakeRenew = async () => {
    callCount++;
  };

  try {
    startAnonymousTokenRenewal(12 * 60 * 60 * 1000, fakeRenew);

    assert.equal(callCount, 1, "doit appeler le renouvellement immédiatement, sans attendre le premier intervalle");
    assert.ok(
      logSpy.mock.calls.some((c) => /renouvellement anonyme du token Vinted armé/.test(String(c.arguments[0]))),
      "doit logger que le renouvellement périodique est armé"
    );
  } finally {
    stopAnonymousTokenRenewal(); // évite qu'un minuteur de 12h ne garde le process de test ouvert
  }
});

test("stopAnonymousTokenRenewal - sans minuteur armé, ne plante pas (no-op)", () => {
  assert.doesNotThrow(() => stopAnonymousTokenRenewal());
});
