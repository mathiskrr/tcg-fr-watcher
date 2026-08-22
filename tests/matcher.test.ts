import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isFrenchTitle, isSealed, isSealedProductEntry } from "../src/matcher.js";

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

test("isFrenchTitle - abréviations de langue isolées (EN/ENG/GB/UK) et drapeaux emoji", () => {
  assert.equal(isFrenchTitle("Charkos EN 🇬🇧").isFrench, false, "cas réel remonté");
  assert.equal(isFrenchTitle("Charkos ENG").isFrench, false);
  assert.equal(isFrenchTitle("Charkos GB").isFrench, false);
  assert.equal(isFrenchTitle("Charkos UK").isFrench, false);
  assert.equal(isFrenchTitle("Charkos 🇺🇸").isFrench, false);
  assert.equal(isFrenchTitle("Charkos 🇯🇵").isFrench, false);
  assert.equal(isFrenchTitle("Charkos 🇩🇪").isFrench, false);
  assert.equal(isFrenchTitle("Charkos 🇮🇹").isFrench, false);
  assert.equal(isFrenchTitle("Charkos 🇪🇸").isFrench, false);
});

test("isFrenchTitle - 'en' minuscule (préposition française) n'est pas pris pour l'abréviation EN", () => {
  // Sensible à la casse : seul "EN" en majuscules isolées est traité comme un tag de langue.
  // Mode assume-french : aucun mot-clé FR nécessaire, donc si "en" déclenchait à tort le
  // rejet "langue étrangère", ce titre passerait de true à false.
  assert.equal(isFrenchTitle("Carte en parfait état, jamais jouée", "assume-french").isFrench, true);
  assert.equal(isFrenchTitle("Neuf en boite scellée sans autre indice", "assume-french").isFrench, true);
});

test("isSealed - rejette les produits indiqués comme ouverts ou incomplets", () => {
  assert.equal(isSealed("Etb ME05 Fr Nuit Noire Ouverte"), false, "cas réel remonté");
  assert.equal(isSealed("Display Nuit Noire ouvert pour cartes"), false);
  assert.equal(isSealed("Bundle incomplet, il manque 2 boosters"), false);
  assert.equal(isSealed("ETB open box"), false);
});

test("isSealed - rejette les produits reconditionnés ou d'occasion", () => {
  assert.equal(isSealed("Bundle reconditionné nuit noire PBL me05"), false, "cas réel remonté");
  assert.equal(isSealed("ETB reconditionnée nuit noire"), false, "accord féminin");
  assert.equal(isSealed("Displays reconditionnés nuit noire"), false, "accord pluriel");
  assert.equal(isSealed("Booster occasion nuit noire"), false);
});

test("isSealed - accepte les produits scellés (aucune mention d'ouverture)", () => {
  assert.equal(isSealed("ETB Nuit Noire ME05 scellé neuf"), true);
  assert.equal(isSealed("Display Pokémon Nuit Noire ME05 – 36 boosters – Neuve scellée FR"), true);
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
