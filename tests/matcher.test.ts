import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isFrenchTitle } from "../src/matcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TitleFixture {
  title: string;
  expected: boolean;
  note: string;
}

const fixtures: TitleFixture[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures/titles.json"), "utf-8")
);

const assumeFrenchFixtures: TitleFixture[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures/titles-assume-french.json"), "utf-8")
);

test("isFrenchTitle - mode strict (défaut, eBay) - fixtures FR/EN/JP/DE/IT/ES", () => {
  for (const { title, expected, note } of fixtures) {
    const result = isFrenchTitle(title);
    assert.equal(
      result.isFrench,
      expected,
      `titre="${title}" (${note}) -> attendu ${expected}, obtenu ${result.isFrench} (${result.reason})`
    );
  }
});

test("isFrenchTitle - mode strict - titre sans aucun indice de langue est rejeté par défaut", () => {
  const result = isFrenchTitle("Pokemon TCG rare card holo");
  assert.equal(result.isFrench, false);
});

test("isFrenchTitle - mode assume-french (Vinted) - fixtures FR/EN/JP/DE/IT/ES", () => {
  for (const { title, expected, note } of assumeFrenchFixtures) {
    const result = isFrenchTitle(title, "assume-french");
    assert.equal(
      result.isFrench,
      expected,
      `titre="${title}" (${note}) -> attendu ${expected}, obtenu ${result.isFrench} (${result.reason})`
    );
  }
});

test("isFrenchTitle - le mode change le résultat pour un titre sans indice de langue", () => {
  const ambiguousTitle = "Carte Pokémon";

  assert.equal(isFrenchTitle(ambiguousTitle).isFrench, false); // strict = mode par défaut
  assert.equal(isFrenchTitle(ambiguousTitle, "strict").isFrench, false);
  assert.equal(isFrenchTitle(ambiguousTitle, "assume-french").isFrench, true);
});

test("isFrenchTitle - une langue étrangère explicite reste rejetée quel que soit le mode", () => {
  const foreignTitle = "Charizard ex 199 English Card MINT";

  assert.equal(isFrenchTitle(foreignTitle, "strict").isFrench, false);
  assert.equal(isFrenchTitle(foreignTitle, "assume-french").isFrench, false);
});
