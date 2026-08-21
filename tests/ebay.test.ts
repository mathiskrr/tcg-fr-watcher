import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchEbay } from "../src/ebay.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const oauthFixtures = JSON.parse(readFileSync(join(__dirname, "fixtures/ebay-oauth.json"), "utf-8"));
const searchFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/ebay-search-response.json"), "utf-8")
);

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

// getAccessToken() met le token en cache au niveau du module ebay.ts (comportement
// voulu : un seul appel OAuth par process tant que le token n'a pas expiré). Les tests
// ci-dessous s'appuient donc sur CET ORDRE D'EXÉCUTION précis :
//   1. échec OAuth (aucun token encore en cache)
//   2. succès OAuth + Browse API (peuple le cache)
//   3. réutilisation du cache (aucun second appel OAuth)
// node:test exécute les tests d'un même fichier séquentiellement dans l'ordre de
// déclaration, donc cet ordre est garanti sans mock de temps.

async function withMockedFetch<T>(
  oauthResponse: () => Response,
  searchResponse: () => Response,
  run: (calls: { oauth: CapturedRequest[]; search: CapturedRequest[] }) => Promise<T>
): Promise<T> {
  const calls = { oauth: [] as CapturedRequest[], search: [] as CapturedRequest[] };
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("identity/v1/oauth2/token")) {
      calls.oauth.push({ url: urlStr, init });
      return oauthResponse();
    }
    if (urlStr.includes("buy/browse/v1/item_summary/search")) {
      calls.search.push({ url: urlStr, init });
      return searchResponse();
    }
    throw new Error(`URL inattendue appelée par le test: ${urlStr}`);
  }) as typeof fetch;

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("1. searchEbay - un échec OAuth (identifiants invalides) est propagé comme rejet", async () => {
  await withMockedFetch(
    () => Response.json(oauthFixtures.error, { status: 401 }),
    () => {
      throw new Error("la Browse API ne doit pas être appelée si l'OAuth échoue");
    },
    async (calls) => {
      await assert.rejects(() => searchEbay("Dracaufeu ex carte française"), /eBay OAuth a échoué: 401/);
      assert.equal(calls.oauth.length, 1);
      assert.equal(calls.search.length, 0);
    }
  );
});

test("2. searchEbay - récupère un token puis interroge la Browse API avec les bons paramètres", async () => {
  await withMockedFetch(
    () => Response.json(oauthFixtures.success),
    () => Response.json(searchFixture),
    async (calls) => {
      const items = await searchEbay("Dracaufeu ex carte française");

      // --- requête OAuth ---
      assert.equal(calls.oauth.length, 1);
      const oauthInit = calls.oauth[0].init!;
      assert.equal(oauthInit.method, "POST");
      const headers = oauthInit.headers as Record<string, string>;
      const expectedBasicAuth = `Basic ${Buffer.from("test-app-id:test-cert-id").toString("base64")}`;
      assert.equal(headers.Authorization, expectedBasicAuth);
      const body = oauthInit.body as URLSearchParams;
      assert.equal(body.get("grant_type"), "client_credentials");
      assert.equal(body.get("scope"), "https://api.ebay.com/oauth/api_scope");

      // --- requête Browse API ---
      assert.equal(calls.search.length, 1);
      const searchCall = calls.search[0];
      const searchUrl = new URL(searchCall.url);
      assert.equal(searchUrl.searchParams.get("q"), "Dracaufeu ex carte française");
      assert.equal(searchUrl.searchParams.get("limit"), "50");
      assert.equal(searchUrl.searchParams.get("category_ids"), "183454");
      const searchHeaders = searchCall.init!.headers as Record<string, string>;
      assert.equal(searchHeaders.Authorization, `Bearer ${oauthFixtures.success.access_token}`);
      assert.equal(searchHeaders["X-EBAY-C-MARKETPLACE-ID"], "EBAY_FR");

      // --- mapping de la réponse ---
      assert.equal(items.length, 2); // le 3e item de la fixture n'a pas de prix -> filtré
      assert.deepEqual(items[0], {
        itemId: "v1|111111111111|0",
        title: "Dracaufeu ex 199 carte française VF NEUF",
        price: 35,
        currency: "EUR",
        url: "https://www.ebay.fr/itm/111111111111",
        imageUrl: "https://i.ebayimg.com/images/g/aaa/s-l500.jpg",
      });
      assert.deepEqual(items[1], {
        itemId: "v1|222222222222|0",
        title: "Mew ex 205 carte française",
        price: 12.5,
        currency: "EUR",
        url: "https://www.ebay.fr/itm/222222222222",
        imageUrl: null, // pas de champ "image" dans la fixture -> null
      });
    }
  );
});

test("3. searchEbay - réutilise le token en cache, sans second appel OAuth", async () => {
  await withMockedFetch(
    () => {
      throw new Error("l'OAuth ne doit pas être rappelé tant que le token en cache est valide");
    },
    () => Response.json(searchFixture),
    async (calls) => {
      const items = await searchEbay("Mew ex carte française");

      assert.equal(calls.oauth.length, 0);
      assert.equal(calls.search.length, 1);
      assert.equal(items.length, 2);
    }
  );
});
