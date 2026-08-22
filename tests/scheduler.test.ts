import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge (importé transitivement par scheduler.js)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectCheapestN,
  hasTop3Changed,
  vintedQueries,
  dedupeByItemId,
  type Candidate,
} from "../src/scheduler.js";
import type { MarketplaceItem } from "../src/types.js";

function makeItem(itemId: string, title = `Item ${itemId}`): MarketplaceItem {
  return { itemId, title, price: 10, currency: "EUR", url: `https://example.test/${itemId}`, imageUrl: null };
}

function makeCandidate(itemId: string, price: number, source = "vinted"): Candidate {
  const item: MarketplaceItem = {
    itemId,
    title: `Item ${itemId}`,
    price,
    currency: "EUR",
    url: `https://example.test/${itemId}`,
    imageUrl: null,
  };
  return { source, itemKey: `${source}:${itemId}`, item, reason: "test" };
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

test("vintedQueries - une chaîne simple devient un tableau à un élément", () => {
  assert.deepEqual(vintedQueries({ vintedQuery: "display Nuit Noire", ebayQuery: "fallback" }), [
    "display Nuit Noire",
  ]);
});

test("vintedQueries - un tableau de variantes est renvoyé tel quel", () => {
  // Cas réel : "ME05" et "ME5" cohabitent chez les vendeurs Vinted pour désigner le même set
  // -> une entrée peut fournir les deux variantes de requête (voir watchlist.json).
  assert.deepEqual(
    vintedQueries({ vintedQuery: ["display Nuit Noire ME05", "display Nuit Noire ME5"], ebayQuery: "fallback" }),
    ["display Nuit Noire ME05", "display Nuit Noire ME5"]
  );
});

test("vintedQueries - absente/null -> repli sur ebayQuery", () => {
  assert.deepEqual(vintedQueries({ vintedQuery: undefined, ebayQuery: "fallback" }), ["fallback"]);
  assert.deepEqual(vintedQueries({ vintedQuery: null, ebayQuery: "fallback" }), ["fallback"]);
});

test("dedupeByItemId - fusionne plusieurs listes en retirant les doublons par itemId", () => {
  // Une même annonce peut matcher deux variantes de requête (ex: une annonce "ME05" trouvée
  // par la requête "ME05" ET par une requête plus large) -> elle ne doit apparaître qu'une
  // fois dans le résultat fusionné.
  const listA = [makeItem("1"), makeItem("2")];
  const listB = [makeItem("2"), makeItem("3")];

  const merged = dedupeByItemId([listA, listB]);

  assert.deepEqual(
    merged.map((i) => i.itemId),
    ["1", "2", "3"]
  );
});

test("dedupeByItemId - liste vide de listes -> résultat vide", () => {
  assert.deepEqual(dedupeByItemId([]), []);
});

test("hasTop3Changed - jamais envoyé auparavant (lastIds null) -> toujours considéré changé", () => {
  assert.equal(hasTop3Changed(["a", "b", "c"], null), true);
});

test("hasTop3Changed - même trio d'ids, même ordre -> pas changé", () => {
  assert.equal(hasTop3Changed(["a", "b", "c"], ["a", "b", "c"]), false);
});

test("hasTop3Changed - même trio d'ids, ordre différent -> pas changé (seule la composition compte)", () => {
  assert.equal(hasTop3Changed(["a", "b", "c"], ["c", "a", "b"]), false);
});

test("hasTop3Changed - un item différent -> changé", () => {
  assert.equal(hasTop3Changed(["a", "b", "d"], ["a", "b", "c"]), true);
});

test("hasTop3Changed - tailles différentes -> changé", () => {
  assert.equal(hasTop3Changed(["a", "b"], ["a", "b", "c"]), true);
});

test("scénario 2 cycles : le top 3 se recalcule sur l'ensemble des résultats, l'alerte ne repart que si sa composition change", () => {
  // Simule le comportement de alertCheapestForSource : le top 3 est recalculé sur TOUS les
  // résultats du cycle (pas de filtre "déjà vu" en amont), et on ne renvoie les 3 alertes
  // que si l'ensemble des 3 ids diffère du dernier envoi pour cette entrée+source.
  let lastAlertedIds: string[] | null = null;

  // Cycle 1 : 5 annonces disponibles, jamais alerté avant -> envoi des 3 moins chères.
  const cycle1 = [
    makeCandidate("a", 10),
    makeCandidate("b", 20),
    makeCandidate("c", 30),
    makeCandidate("d", 40),
    makeCandidate("e", 50),
  ];
  const top1 = selectCheapestN(cycle1, 3);
  const ids1 = top1.map((c) => c.itemKey);
  const changed1 = hasTop3Changed(ids1, lastAlertedIds);
  if (changed1) lastAlertedIds = ids1;

  assert.deepEqual(top1.map((c) => c.item.itemId), ["a", "b", "c"]);
  assert.equal(changed1, true, "1er envoi pour cette entrée -> toujours considéré changé");

  // Cycle 2 : mêmes 5 annonces, rien n'a changé -> le top 3 recalculé est identique -> pas
  // de nouvel envoi, même si on "recalcule tout" à chaque cycle.
  const top2 = selectCheapestN(cycle1, 3);
  const ids2 = top2.map((c) => c.itemKey);
  const changed2 = hasTop3Changed(ids2, lastAlertedIds);

  assert.deepEqual(top2.map((c) => c.item.itemId), ["a", "b", "c"]);
  assert.equal(changed2, false, "même top 3 qu'au dernier envoi -> aucune alerte");

  // Cycle 3 : "a" a disparu (vendue), une nouvelle annonce "f" à 5€ apparaît moins chère que
  // tout le reste -> le top 3 change de composition -> les 3 alertes repartent EN ENTIER
  // (pas seulement "f").
  const cycle3 = [
    makeCandidate("f", 5),
    makeCandidate("b", 20),
    makeCandidate("c", 30),
    makeCandidate("d", 40),
    makeCandidate("e", 50),
  ];
  const top3 = selectCheapestN(cycle3, 3);
  const ids3 = top3.map((c) => c.itemKey);
  const changed3 = hasTop3Changed(ids3, lastAlertedIds);
  if (changed3) lastAlertedIds = ids3;

  assert.deepEqual(top3.map((c) => c.item.itemId), ["f", "b", "c"]);
  assert.equal(changed3, true, "'a' est sorti du top 3, 'f' y est entré -> composition changée");

  // Cycle 4 : même composition que le cycle 3 mais "c" est maintenant moins cher que "b"
  // (permutation de prix entre les mêmes 3 items) -> toujours les mêmes 3 ids -> pas de
  // nouvel envoi (seule la composition du top 3 compte, pas le rang de prix entre eux).
  const cycle4 = [
    makeCandidate("f", 5),
    makeCandidate("b", 35),
    makeCandidate("c", 15),
    makeCandidate("d", 40),
    makeCandidate("e", 50),
  ];
  const top4 = selectCheapestN(cycle4, 3);
  const ids4 = top4.map((c) => c.itemKey);
  const changed4 = hasTop3Changed(ids4, lastAlertedIds);

  assert.deepEqual(top4.map((c) => c.item.itemId), ["f", "c", "b"]); // "c" et "b" permutés
  assert.equal(changed4, false, "mêmes 3 items, juste réordonnés par prix -> aucune alerte");
});
