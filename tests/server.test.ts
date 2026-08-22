import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge (importé transitivement par server.js)

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createAdminServer } from "../src/server.js";
import { getVintedAccessToken, setVintedAccessToken } from "../src/tokenStore.js";

const SECRET = "test-secret-do-not-use-in-prod-32c";

// Démarre le serveur sur un port éphémère (0), l'appelle, puis le referme -- pas de port fixe
// pour rester exécutable en parallèle / sur CI sans collision.
async function withServer<T>(secret: string, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createAdminServer(secret);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("POST /token - refuse sans header Authorization (401)", async () => {
  await withServer(SECRET, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "nouveau-token" }),
    });

    assert.equal(res.status, 401);
  });
});

test("POST /token - refuse avec un mauvais secret (401)", async () => {
  await withServer(SECRET, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { Authorization: "Bearer un-mauvais-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ token: "nouveau-token" }),
    });

    assert.equal(res.status, 401);
  });
});

test("POST /token - accepte avec le bon secret et met à jour le token en mémoire (tokenStore)", async () => {
  await withServer(SECRET, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "nouveau-token-de-test" }),
    });

    assert.equal(res.status, 200);
    assert.equal(getVintedAccessToken(), "nouveau-token-de-test");
  });
});

test("POST /token - renvoie l'expiration décodée du JWT fourni", async () => {
  // JWT factice (non signé) avec exp dans 1h, juste pour vérifier que le serveur décode et
  // renvoie bien cette date (voir decodeJwtExpiry dans vinted.ts, déjà testé isolément).
  const expSeconds = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  const fakeJwt = `${header}.${payload}.sig`;

  await withServer(SECRET, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: fakeJwt }),
    });

    const body = (await res.json()) as { ok: boolean; tokenExpiresAt: string | null };
    assert.equal(body.ok, true);
    assert.equal(body.tokenExpiresAt, new Date(expSeconds * 1000).toISOString());
  });
});

test("POST /token - 400 si le champ 'token' est manquant ou vide", async () => {
  await withServer(SECRET, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const empty = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "   " }),
    });
    assert.equal(empty.status, 400);
  });
});

test("POST /token - 400 sur un corps qui n'est pas du JSON valide", async () => {
  await withServer(SECRET, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: "pas du json",
    });

    assert.equal(res.status, 400);
  });
});

test("GET /status - nécessite aussi l'authentification (401 sans le bon secret)", async () => {
  await withServer(SECRET, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/status`);
    assert.equal(res.status, 401);
  });
});

test("GET /status - renvoie l'état courant avec le bon secret", async () => {
  setVintedAccessToken("token-pour-le-test-status");

  await withServer(SECRET, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/status`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      tokenPresent: boolean;
      tokenExpiresAt: string | null;
      lastCycleCompletedAt: string | null;
      watchlistEntryCount: number;
    };
    assert.equal(body.tokenPresent, true);
    // watchlistEntryCount dépend du watchlist.json réel du dépôt -> on vérifie juste la
    // forme (nombre positif), pas une valeur exacte qui rendrait ce test fragile.
    assert.equal(typeof body.watchlistEntryCount, "number");
    assert.ok(body.watchlistEntryCount >= 0);
    // Aucun cycle n'a tourné dans ce process de test -> null.
    assert.equal(body.lastCycleCompletedAt, null);
  });
});

test("route inconnue -> 404 (même avec le bon secret)", async () => {
  await withServer(SECRET, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/route-inexistante`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.status, 404);
  });
});

test("un secret refusé n'est JAMAIS présent dans les logs", async (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  const attemptedSecret = "un-secret-tres-sensible-jamais-logge-12345";

  await withServer(SECRET, async (baseUrl) => {
    await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${attemptedSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "x" }),
    });
  });

  assert.equal(warnSpy.mock.callCount(), 1, "une tentative refusée doit être loggée (sans le secret)");
  const loggedMessage = String(warnSpy.mock.calls[0].arguments[0]);
  assert.doesNotMatch(loggedMessage, new RegExp(attemptedSecret));
});

test("le token Vinted mis à jour n'est JAMAIS présent dans les logs", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const sensitiveToken = "jwt-tout-a-fait-secret-abcdefghijklmnop";

  await withServer(SECRET, async (baseUrl) => {
    await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: sensitiveToken }),
    });
  });

  const allLoggedMessages = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.doesNotMatch(allLoggedMessages, new RegExp(sensitiveToken));
});
