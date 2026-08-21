import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sendDealAlert } from "../src/discord.js";
import type { EbayItem } from "../src/ebay.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DealFixture {
  item: EbayItem;
  referencePrice: number;
  discountPercent: number;
}

const fixtures: DealFixture[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures/deal-items.json"), "utf-8")
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

test("sendDealAlert - construit un embed conforme pour chaque fixture", async () => {
  await withMockedFetch(
    () => new Response(null, { status: 204 }),
    async (calls) => {
      for (const { item, referencePrice, discountPercent } of fixtures) {
        await sendDealAlert(item, referencePrice, discountPercent);
      }

      assert.equal(calls.length, fixtures.length);

      calls.forEach((call, i) => {
        const { item, referencePrice, discountPercent } = fixtures[i];
        const embed = call.body.embeds[0];

        assert.equal(embed.title, item.title);
        assert.equal(embed.url, item.url);
        assert.equal(embed.fields[0].value, `${item.price.toFixed(2)} €`);
        assert.equal(embed.fields[1].value, `${referencePrice.toFixed(2)} €`);
        assert.equal(embed.fields[2].value, `-${discountPercent}%`);
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

test("sendDealAlert - lève une erreur si le webhook Discord répond en échec", async () => {
  await withMockedFetch(
    () => new Response("bad request", { status: 400 }),
    async () => {
      const [{ item, referencePrice, discountPercent }] = fixtures;
      await assert.rejects(() => sendDealAlert(item, referencePrice, discountPercent));
    }
  );
});
