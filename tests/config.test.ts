import "./env.js"; // doit rester le premier import : peuple process.env avant que src/config.ts ne se charge

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnabledSources } from "../src/config.js";

test("parseEnabledSources - par défaut (non défini), toutes les sources sont actives", () => {
  assert.deepEqual(parseEnabledSources(undefined), ["ebay", "vinted"]);
  assert.deepEqual(parseEnabledSources(""), ["ebay", "vinted"]);
  assert.deepEqual(parseEnabledSources("   "), ["ebay", "vinted"]);
});

test("parseEnabledSources - une seule source", () => {
  assert.deepEqual(parseEnabledSources("vinted"), ["vinted"]);
  assert.deepEqual(parseEnabledSources("ebay"), ["ebay"]);
});

test("parseEnabledSources - plusieurs sources, espaces et casse tolérés", () => {
  assert.deepEqual(parseEnabledSources("ebay, vinted"), ["ebay", "vinted"]);
  assert.deepEqual(parseEnabledSources(" EBAY , Vinted "), ["ebay", "vinted"]);
});

test("parseEnabledSources - rejette une source inconnue", () => {
  assert.throws(() => parseEnabledSources("leboncoin"), /ENABLED_SOURCES contient des valeurs inconnues/);
  assert.throws(() => parseEnabledSources("ebay,leboncoin"), /leboncoin/);
});

test("parseEnabledSources - rejette une liste vide après nettoyage (ex: virgules seules)", () => {
  assert.throws(() => parseEnabledSources(",,"), /au moins une source doit être activée/);
});
