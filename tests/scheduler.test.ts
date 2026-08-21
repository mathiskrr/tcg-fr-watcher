import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge (importé transitivement par scheduler.js)

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCheapestN, isSealedProductEntry, type Candidate } from "../src/scheduler.js";
import type { MarketplaceItem } from "../src/types.js";

function makeCandidate(itemId: string, price: number, source = "vinted"): Candidate {
  const item: MarketplaceItem = {
    itemId,
    title: `Item ${itemId}`,
    price,
    currency: "EUR",
    url: `https://example.test/${itemId}`,
    imageUrl: null,
  };
  return { source, seenKey: `${source}:${itemId}`, item, reason: "test" };
}

test("selectCheapestN - sous le seuil, renvoie tout, trié par prix croissant", () => {
  const items = [makeCandidate("1", 10), makeCandidate("2", 5), makeCandidate("3", 20)];

  const cheapest = selectCheapestN(items, 5);

  assert.equal(cheapest.length, 3);
  assert.deepEqual(
    cheapest.map((c) => c.item.itemId),
    ["2", "1", "3"]
  );
});

test("selectCheapestN - au-delà du seuil, ne garde que les N moins chères", () => {
  const items = Array.from({ length: 44 }, (_, i) => makeCandidate(String(i), 100 - i));
  // Prix : item "0" -> 100€ (le plus cher) ... item "43" -> 57€ (le moins cher).

  const cheapest = selectCheapestN(items, 3);

  assert.equal(cheapest.length, 3);
  assert.deepEqual(
    cheapest.map((c) => c.item.price),
    [57, 58, 59]
  );
  assert.deepEqual(
    cheapest.map((c) => c.item.itemId),
    ["43", "42", "41"]
  );
});

test("selectCheapestN - ne modifie pas le tableau passé en entrée", () => {
  const items = [makeCandidate("1", 30), makeCandidate("2", 10)];
  const originalOrder = items.map((c) => c.item.itemId);

  selectCheapestN(items, 1);

  assert.deepEqual(
    items.map((c) => c.item.itemId),
    originalOrder
  );
});

test("selectCheapestN - se recalcule sur l'ensemble des résultats, pas seulement les nouveaux (via un scénario 2 cycles)", () => {
  // Simule le comportement attendu au niveau de checkEntry : le classement "top N moins
  // chères" est recalculé sur TOUS les résultats du cycle, la dédup (seen_items) étant
  // appliquée ensuite, séparément, uniquement pour décider quoi (re)alerter.
  const seen = new Set<string>();

  // Cycle 1 : 5 annonces disponibles.
  const cycle1 = [
    makeCandidate("a", 10),
    makeCandidate("b", 20),
    makeCandidate("c", 30),
    makeCandidate("d", 40),
    makeCandidate("e", 50),
  ];
  const top1 = selectCheapestN(cycle1, 3);
  const toAlert1 = top1.filter((c) => !seen.has(c.seenKey));
  for (const c of toAlert1) seen.add(c.seenKey);

  assert.deepEqual(
    top1.map((c) => c.item.itemId),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    toAlert1.map((c) => c.item.itemId),
    ["a", "b", "c"]
  ); // tout est nouveau au 1er cycle

  // Cycle 2 : "a" a disparu (vendue), une nouvelle annonce "f" à 5€ apparaît moins chère
  // que tout le reste. "b" et "c" sont toujours là (déjà alertées au cycle 1).
  const cycle2 = [
    makeCandidate("f", 5),
    makeCandidate("b", 20),
    makeCandidate("c", 30),
    makeCandidate("d", 40),
    makeCandidate("e", 50),
  ];
  const top2 = selectCheapestN(cycle2, 3);
  const toAlert2 = top2.filter((c) => !seen.has(c.seenKey));

  assert.deepEqual(
    top2.map((c) => c.item.itemId),
    ["f", "b", "c"]
  ); // recalculé sur l'ensemble des résultats du cycle 2, pas seulement "f" qui est nouveau
  assert.deepEqual(
    toAlert2.map((c) => c.item.itemId),
    ["f"]
  ); // "b" et "c" déjà alertées au cycle 1 -> pas de re-notification
});

test("selectCheapestN - classement indépendant par source (checkEntry appelle la fonction une fois par source, pas sur un pool combiné)", () => {
  // eBay nettement plus cher que Vinted sur ce cas : un classement combiné laisserait
  // Vinted éclipser totalement eBay. scheduler.ts appelle donc selectCheapestN séparément
  // par source (voir alertCheapestForSource) pour garantir jusqu'à 3 alertes par source.
  const ebayMatches = [
    makeCandidate("e1", 200, "ebay"),
    makeCandidate("e2", 150, "ebay"),
    makeCandidate("e3", 180, "ebay"),
    makeCandidate("e4", 300, "ebay"),
  ];
  const vintedMatches = [
    makeCandidate("v1", 5, "vinted"),
    makeCandidate("v2", 8, "vinted"),
    makeCandidate("v3", 3, "vinted"),
    makeCandidate("v4", 12, "vinted"),
  ];

  const topEbay = selectCheapestN(ebayMatches, 3);
  const topVinted = selectCheapestN(vintedMatches, 3);

  // Les 3 moins chères eBay sont bien remontées, malgré des prix largement supérieurs à
  // toutes les annonces Vinted -> preuve que les classements ne se mélangent pas.
  assert.deepEqual(
    topEbay.map((c) => c.item.itemId),
    ["e2", "e3", "e1"]
  );
  assert.deepEqual(
    topVinted.map((c) => c.item.itemId),
    ["v3", "v1", "v2"]
  );
});

test("isSealedProductEntry - identifie les entrées watchlist de produits scellés par leur nom", () => {
  assert.equal(isSealedProductEntry("Display Nuit Noire (36 boosters)"), true);
  assert.equal(isSealedProductEntry("Demi-display Nuit Noire (18 boosters)"), true); // "display" y figure
  assert.equal(isSealedProductEntry("ETB Nuit Noire"), true);
  assert.equal(isSealedProductEntry("Bundle 6 boosters Nuit Noire"), true);
  assert.equal(isSealedProductEntry("Tripack Nuit Noire"), true);
  assert.equal(isSealedProductEntry("Booster Nuit Noire (unité)"), true);
});

test("isSealedProductEntry - une entrée carte à l'unité n'est pas identifiée comme produit scellé", () => {
  assert.equal(isSealedProductEntry("Méga-Darkrai-ex 116/084 (SIR)"), false);
  assert.equal(isSealedProductEntry("Mimantis 085/084 (AR)"), false);
});
