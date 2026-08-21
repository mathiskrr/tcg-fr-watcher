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

test("sendNewListingAlert - construit un embed conforme pour chaque fixture", async () => {
  await withMockedFetch(
    () => new Response(null, { status: 204 }),
    async (calls) => {
      for (const item of fixtures) {
        await sendNewListingAlert(item);
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
      await assert.rejects(() => sendNewListingAlert(fixtures[0]));
    }
  );
});
