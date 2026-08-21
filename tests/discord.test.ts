import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sendNewListingAlert } from "../src/discord.js";
import type { MarketplaceItem } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtures: MarketplaceItem[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures/listing-items.json"), "utf-8")
);

interface CapturedCall {
  url: string;
  body: any;
}

// Remplace globalThis.fetch le temps du test, capture les requêtes envoyées au webhook.
async function withMockedFetch<T>(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  run: (calls: CapturedCall[]) => Promise<T>
): Promise<T> {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return handler(url, init);
  }) as typeof fetch;

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// minIntervalMs=1 dans les tests ci-dessous : évite que le throttle anti-429 (500ms par
// défaut, voir src/discord.ts) ne ralentisse inutilement des tests qui ne testent pas ce
// comportement précis (celui-ci est vérifié séparément plus bas).
test("sendNewListingAlert - construit un embed conforme pour chaque fixture", async () => {
  await withMockedFetch(
    () => new Response(null, { status: 204 }),
    async (calls) => {
      for (const item of fixtures) {
        await sendNewListingAlert(item, 1);
      }

      assert.equal(calls.length, fixtures.length);

      calls.forEach((call, i) => {
        const item = fixtures[i];
        const embed = call.body.embeds[0];

        assert.equal(embed.title, item.title);
        assert.equal(embed.url, item.url);
        assert.equal(embed.fields.length, 1);
        assert.equal(embed.fields[0].name, "Prix");
        assert.equal(embed.fields[0].value, `${item.price.toFixed(2)} €`);
        assert.match(embed.footer.text, new RegExp(item.itemId));

        if (item.imageUrl) {
          assert.equal(embed.thumbnail.url, item.imageUrl);
        } else {
          assert.equal(embed.thumbnail, undefined);
        }
      });
    }
  );
});

test("sendNewListingAlert - lève une erreur si le webhook Discord répond en échec", async () => {
  await withMockedFetch(
    () => new Response("bad request", { status: 400 }),
    async () => {
      await assert.rejects(() => sendNewListingAlert(fixtures[0], 1));
    }
  );
});

test("sendNewListingAlert - espace les envois consécutifs d'au moins minIntervalMs (anti rate-limit 429)", async () => {
  const minIntervalMs = 150;

  // `lastSentAt` (src/discord.ts) est un état de module partagé par tout le fichier de
  // test : on laisse s'écouler assez de temps pour neutraliser un throttle résiduel d'un
  // test précédent, afin que le 1er envoi ci-dessous parte immédiatement à coup sûr et que
  // seul le 2e soit mesuré comme retardé (test déterministe, indépendant de l'ordre).
  await new Promise((resolve) => setTimeout(resolve, minIntervalMs + 50));

  await withMockedFetch(
    () => new Response(null, { status: 204 }),
    async () => {
      const start = performance.now();
      await sendNewListingAlert(fixtures[0], minIntervalMs);
      const afterFirst = performance.now();
      await sendNewListingAlert(fixtures[1], minIntervalMs);
      const afterSecond = performance.now();

      const firstCallDuration = afterFirst - start;
      const secondCallDuration = afterSecond - afterFirst;

      assert.ok(
        firstCallDuration < 50,
        `le 1er envoi ne devrait pas être throttlé, mesuré ${firstCallDuration.toFixed(1)}ms`
      );
      assert.ok(
        secondCallDuration >= minIntervalMs - 20,
        `le 2e envoi doit attendre ~${minIntervalMs}ms, mesuré ${secondCallDuration.toFixed(1)}ms`
      );
    }
  );
});
