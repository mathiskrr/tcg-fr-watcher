import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchVinted, decodeJwtExpiry, isRelevantToQuery } from "../src/vinted.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const searchFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/vinted-search-response.json"), "utf-8")
);

interface RelevanceFixture {
  title: string;
  query: string;
  expected: boolean;
  note: string;
}

const relevanceFixtures: RelevanceFixture[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures/vinted-relevance.json"), "utf-8")
);

// Construit un faux JWT (header.payload.signature, non signé) juste pour exercer le
// décodage du payload -- decodeJwtExpiry ne vérifie pas la signature, il lit "exp".
function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

// Monte un fetch mocké renvoyant les réponses de `responses` dans l'ordre à chaque
// appel (la dernière est réutilisée si searchVinted appelle fetch plus de fois que
// `responses` n'en contient) ; utile pour simuler un retry qui finit par réussir.
async function withMockedFetch<T>(
  responses: Array<() => Response>,
  run: (calls: CapturedRequest[]) => Promise<T>
): Promise<T> {
  const calls: CapturedRequest[] = [];
  let callIndex = 0;
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const factory = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return factory();
  }) as typeof fetch;

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("searchVinted - construit la requête avec les bons paramètres et mappe la réponse", async () => {
  await withMockedFetch([() => Response.json(searchFixture)], async (calls) => {
    const items = await searchVinted("Pokémon Nuit Noire");

    assert.equal(calls.length, 1);
    const requestUrl = new URL(calls[0].url);
    assert.equal(requestUrl.searchParams.get("search_text"), "Pokémon Nuit Noire");
    // Pas de catalog_ids : vérifié empiriquement que ce paramètre fait ignorer search_text
    // par l'API Vinted réelle (voir commentaire dans src/vinted.ts).
    assert.equal(requestUrl.searchParams.has("catalog_ids"), false);
    assert.equal(requestUrl.searchParams.get("order"), "newest_first");
    assert.equal(requestUrl.searchParams.get("per_page"), "50");

    const headers = calls[0].init!.headers as Record<string, string>;
    assert.match(headers["User-Agent"], /Mozilla/);
    assert.equal(headers.Referer, "https://www.vinted.fr/catalog");
    assert.equal(headers.Cookie, undefined); // pas de VINTED_ACCESS_TOKEN_WEB configuré dans les tests

    assert.equal(items.length, 2); // le 3e item de la fixture n'a pas de prix -> filtré
    assert.deepEqual(items[0], {
      itemId: "4455667788",
      title: "Carte Pokémon Dracaufeu VF Nuit Noire",
      price: 18.5,
      currency: "EUR",
      url: "https://www.vinted.fr/items/4455667788-carte-pokemon-dracaufeu-vf-nuit-noire",
      imageUrl: "https://images1.vinted.net/t/abc/photo.jpg",
    });
    assert.deepEqual(items[1], {
      itemId: "4455667799",
      title: "Mew ex 205 Nuit Noire carte française",
      price: 9,
      currency: "EUR",
      url: "https://www.vinted.fr/items/4455667799-carte-mew-ex",
      imageUrl: null, // pas de champ "photo" dans la fixture -> null
    });
  });
});

test("searchVinted - envoie bien la query dans le paramètre search_text (et rien d'autre en catalog_ids)", async () => {
  const query = "display Nuit Noire ME05 36 boosters";

  await withMockedFetch([() => Response.json(searchFixture)], async (calls) => {
    await searchVinted(query);

    const requestUrl = new URL(calls[0].url);
    assert.equal(requestUrl.searchParams.get("search_text"), query);
    assert.equal(requestUrl.searchParams.has("catalog_ids"), false);
  });
});

test("isRelevantToQuery - fixtures issues d'observations réelles (Vinted ne renvoie jamais un résultat vide)", () => {
  for (const { title, query, expected, note } of relevanceFixtures) {
    const got = isRelevantToQuery(title, query);
    assert.equal(
      got,
      expected,
      `titre="${title}" query="${query}" (${note}) -> attendu ${expected}, obtenu ${got}`
    );
  }
});

test("isRelevantToQuery - la requête a un numéro mais le titre n'en a aucun -> rejeté (pas de fallback mots-clés)", () => {
  // Sans numéro dans le titre, impossible de savoir de quelle variante il s'agit (base, AR,
  // SIR, gold...) : on rejette par défaut plutôt que d'accepter à l'aveugle via le filtre
  // mots-clés, même avec un fort chevauchement ("floramantis", "ex", "nuit", "noire").
  assert.equal(
    isRelevantToQuery(
      "Floramantis ex Nuit Noire ME05 carte française scellée",
      "Floramantis ex 096/084 Nuit Noire ME05"
    ),
    false
  );
});

test("isRelevantToQuery - cas réel diagnostiqué : titre générique sans numéro pollue le classement d'une variante précise", () => {
  // Constaté en prod : pour la requête "Mega Darkrai ex 116/084 Nuit Noire" (carte SIR),
  // ce titre générique (sans aucun numéro, en réalité probablement la carte 048) passait
  // via le fallback mots-clés et, étant bien moins cher, écrasait le top 3 au détriment des
  // vraies annonces 116/084 -> aucune alerte n'était jamais envoyée pour cette variante.
  assert.equal(
    isRelevantToQuery("PBL 048 - Mega Darkrai ex Nuit Noire (ME05) • FR", "Mega Darkrai ex 116/084 Nuit Noire"),
    false
  );
  assert.equal(
    isRelevantToQuery("Méga-Darkrai ex Nuit noire", "Mega Darkrai ex 116/084 Nuit Noire"),
    false
  );
  // Le vrai 116/084, lui, doit toujours passer.
  assert.equal(
    isRelevantToQuery("Pokémon Méga-Darkrai ex SIR 116/084  Nuit Noire", "Mega Darkrai ex 116/084 Nuit Noire"),
    true
  );
});

test("isRelevantToQuery - requête SANS numéro de carte (displays, ETB, bundles...) garde le filtre mots-clés habituel", () => {
  // Pas de numéro dans la requête -> rien à vérifier de plus précis, le comportement
  // mots-clés existant s'applique normalement (annonce réelle pertinente).
  assert.equal(
    isRelevantToQuery(
      "Display Pokémon Nuit Noire ME05 – 36 boosters – Neuve scellée FR",
      "display Nuit Noire ME05 36 boosters"
    ),
    true
  );
});

test("isRelevantToQuery - un numéro de carte différent rejette même avec un fort chevauchement de mots-clés", () => {
  // Même carte, même set, mais un numéro de variante différent (ex: base vs Alt Art) :
  // le chevauchement de mots-clés seul ("floramantis", "ex", "nuit", "noire") serait
  // largement suffisant pour matcher sans la vérification stricte du numéro.
  assert.equal(isRelevantToQuery("Floramantis ex 004/084 Nuit noire", "Floramantis ex 096/084"), false);
});

test("searchVinted - filtre les résultats hors-sujet renvoyés par le fallback Vinted", async () => {
  const mixedResponse = {
    items: [
      {
        id: 1,
        title: "Display Pokémon Nuit Noire ME05 – 36 boosters – Neuve scellée FR",
        price: { amount: "180.00", currency_code: "EUR" },
        url: "https://www.vinted.fr/items/1-display-nuit-noire",
      },
      {
        id: 2,
        title: "Carte One Piece - Case de 24 Blister One Piece OP15",
        price: { amount: "190.00", currency_code: "EUR" },
        url: "https://www.vinted.fr/items/2-one-piece",
      },
      {
        id: 3,
        title: "Table de mixage, Yamaha MG 10/2",
        price: { amount: "120.00", currency_code: "EUR" },
        url: "https://www.vinted.fr/items/3-table-mixage",
      },
    ],
  };

  await withMockedFetch([() => Response.json(mixedResponse)], async () => {
    const items = await searchVinted("display Nuit Noire ME05 36 boosters");

    assert.equal(items.length, 1);
    assert.equal(items[0].itemId, "1");
  });
});

for (const blockedStatus of [403, 429]) {
  test(`searchVinted - retente puis échoue clairement sur blocage HTTP ${blockedStatus}`, async (t) => {
    const warnSpy = t.mock.method(console, "warn", () => {});

    // retries/délai réduits uniquement pour que le test reste rapide ; le comportement
    // testé (retry sur 403/429 puis rejet avec log dédié) est celui utilisé en prod.
    await withMockedFetch(
      [() => new Response("blocked", { status: blockedStatus })],
      async (calls) => {
        await assert.rejects(
          () => searchVinted("Dracaufeu ex", 50, 2, 5),
          new RegExp(`Vinted API a échoué: ${blockedStatus}`)
        );

        assert.equal(calls.length, 2, "doit avoir retenté avant d'abandonner");
        assert.equal(warnSpy.mock.callCount(), 1);
        const warnMessage = String(warnSpy.mock.calls[0].arguments[0]);
        assert.match(warnMessage, /blocage anti-bot/i);
        assert.match(warnMessage, new RegExp(String(blockedStatus)));
      }
    );
  });
}

test("searchVinted - se rétablit après une erreur 5xx transitoire", async () => {
  await withMockedFetch(
    [() => new Response("server error", { status: 502 }), () => Response.json(searchFixture)],
    async (calls) => {
      // Query cohérente avec le contenu de la fixture (voir isRelevantToQuery) : les deux
      // items de tests/fixtures/vinted-search-response.json parlent de "Nuit Noire".
      const items = await searchVinted("Pokémon Nuit Noire", 50, 3, 5);

      assert.equal(calls.length, 2);
      assert.equal(items.length, 2);
    }
  );
});

test("decodeJwtExpiry - lit la date d'expiration (claim exp) d'un JWT", () => {
  const expSeconds = Math.floor(Date.now() / 1000) + 3600;
  const token = makeFakeJwt({ exp: expSeconds });

  assert.equal(decodeJwtExpiry(token), expSeconds * 1000);
});

test("decodeJwtExpiry - renvoie null pour un token mal formé ou sans claim exp", () => {
  assert.equal(decodeJwtExpiry("pas-un-jwt"), null);
  assert.equal(decodeJwtExpiry(makeFakeJwt({ sub: "user-1" })), null); // pas de champ exp
  assert.equal(decodeJwtExpiry(""), null);
});

test("searchVinted - envoie le cookie access_token_web quand il est configuré et valide", async (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  const token = makeFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }); // expire dans 1h

  await withMockedFetch([() => Response.json(searchFixture)], async (calls) => {
    await searchVinted("Dracaufeu ex", 50, 3, 5, token);

    const headers = calls[0].init!.headers as Record<string, string>;
    assert.equal(headers.Cookie, `access_token_web=${token}`);
    assert.equal(warnSpy.mock.callCount(), 0, "un token valide ne doit déclencher aucun warning");
  });
});

test("searchVinted - avertit quand le cookie configuré est déjà expiré (détection proactive)", async (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  const token = makeFakeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }); // expiré depuis 1h

  await withMockedFetch([() => Response.json(searchFixture)], async (calls) => {
    // La requête part quand même (l'expiration décodée est une heuristique, pas une
    // certitude absolue) : Vinted reste la source de vérité via un éventuel 401.
    await searchVinted("Dracaufeu ex", 50, 3, 5, token);

    assert.equal(calls.length, 1);
    assert.equal(warnSpy.mock.callCount(), 1);
    const message = String(warnSpy.mock.calls[0].arguments[0]);
    assert.match(message, /access_token_web semble expiré/i);
    assert.match(message, /VINTED_ACCESS_TOKEN_WEB/);
  });
});

test("searchVinted - log clair et explicite quand Vinted répond 401 (session invalide/expirée)", async (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  const token = makeFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

  await withMockedFetch(
    [() => Response.json({ code: 100, message: "invalid_authentication_token" }, { status: 401 })],
    async () => {
      await assert.rejects(
        () => searchVinted("Dracaufeu ex", 50, 3, 5, token),
        /Vinted API a échoué: 401/
      );

      assert.equal(errorSpy.mock.callCount(), 1);
      const message = String(errorSpy.mock.calls[0].arguments[0]);
      assert.match(message, /session invalide ou expirée/i);
      assert.match(message, /VINTED_ACCESS_TOKEN_WEB/);
    }
  );
});
