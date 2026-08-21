import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge (importé transitivement par scheduler.js)

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAlertsWithinCap, type Candidate } from "../src/scheduler.js";
import type { MarketplaceItem } from "../src/types.js";

function makeCandidate(itemId: string, price: number): Candidate {
  const item: MarketplaceItem = {
    itemId,
    title: `Item ${itemId}`,
    price,
    currency: "EUR",
    url: `https://example.test/${itemId}`,
    imageUrl: null,
  };
  return { source: "vinted", seenKey: `vinted:${itemId}`, item, reason: "test" };
}

test("selectAlertsWithinCap - sous le seuil, tout est alerté, rien n'est ignoré", () => {
  const candidates = [makeCandidate("1", 10), makeCandidate("2", 5), makeCandidate("3", 20)];

  const { toAlert, ignored } = selectAlertsWithinCap(candidates, 5);

  assert.equal(toAlert.length, 3);
  assert.equal(ignored.length, 0);
  // Toujours trié par prix croissant, même sous le seuil.
  assert.deepEqual(
    toAlert.map((c) => c.item.itemId),
    ["2", "1", "3"]
  );
});

test("selectAlertsWithinCap - au-delà du seuil, ne garde que les N moins chères", () => {
  // 44 annonces pour une carte très demandée, comme dans l'exemple du besoin.
  const candidates = Array.from({ length: 44 }, (_, i) => makeCandidate(String(i), 100 - i));
  // Prix : item "0" -> 100€ (le plus cher) ... item "43" -> 57€ (le moins cher).

  const { toAlert, ignored } = selectAlertsWithinCap(candidates, 5);

  assert.equal(toAlert.length, 5);
  assert.equal(ignored.length, 39);

  // Les 5 alertées doivent être les 5 moins chères (prix 60, 59, 58, 57... -> items 40..43 et 39).
  const alertedPrices = toAlert.map((c) => c.item.price).sort((a, b) => a - b);
  assert.deepEqual(alertedPrices, [57, 58, 59, 60, 61]);

  // Aucun chevauchement entre alertées et ignorées.
  const alertedIds = new Set(toAlert.map((c) => c.item.itemId));
  for (const c of ignored) {
    assert.equal(alertedIds.has(c.item.itemId), false);
  }
});

test("selectAlertsWithinCap - pile au seuil, rien n'est ignoré", () => {
  const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate(String(i), i));

  const { toAlert, ignored } = selectAlertsWithinCap(candidates, 5);

  assert.equal(toAlert.length, 5);
  assert.equal(ignored.length, 0);
});

test("selectAlertsWithinCap - ne modifie pas le tableau passé en entrée", () => {
  const candidates = [makeCandidate("1", 30), makeCandidate("2", 10)];
  const originalOrder = candidates.map((c) => c.item.itemId);

  selectAlertsWithinCap(candidates, 1);

  assert.deepEqual(
    candidates.map((c) => c.item.itemId),
    originalOrder
  );
});
