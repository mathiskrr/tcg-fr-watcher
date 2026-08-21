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

test("isFrenchTitle - fixtures FR/EN/JP/DE/IT/ES", () => {
  for (const { title, expected, note } of fixtures) {
    const result = isFrenchTitle(title);
    assert.equal(
      result.isFrench,
      expected,
      `titre="${title}" (${note}) -> attendu ${expected}, obtenu ${result.isFrench} (${result.reason})`
    );
  }
});

test("isFrenchTitle - titre sans aucun indice de langue est rejeté par défaut", () => {
  const result = isFrenchTitle("Pokemon TCG rare card holo");
  assert.equal(result.isFrench, false);
});
