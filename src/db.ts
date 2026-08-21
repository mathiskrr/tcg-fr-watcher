import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

// node:sqlite (module intégré à Node, stable depuis 22.5) est utilisé à la place
// de better-sqlite3 pour éviter une compilation native (node-gyp) côté install.
const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");

// L'ancien modèle "seen_items" (dédup par item individuel) est abandonné au profit d'une
// comparaison de classement : on ne stocke plus que le dernier top 3 réellement envoyé par
// entrée+source, pour savoir si le classement a changé d'un cycle à l'autre (voir
// scheduler.ts). Table héritée nettoyée si présente (base de dev locale, pas de migration
// de données à préserver).
db.exec(`
  DROP TABLE IF EXISTS seen_items;

  CREATE TABLE IF NOT EXISTS last_alerted_top3 (
    entry_key TEXT PRIMARY KEY,
    item_ids TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// item_ids : ids triés puis joints par virgule -> comparaison directe possible côté
// scheduler.ts sans requête SQL supplémentaire (le tri se fait à l'écriture).
export function getLastAlertedTop3(entryKey: string): string[] | null {
  const row = db.prepare("SELECT item_ids FROM last_alerted_top3 WHERE entry_key = ?").get(entryKey) as
    | { item_ids: string }
    | undefined;

  if (!row) return null;
  return row.item_ids.split(",");
}

export function setLastAlertedTop3(entryKey: string, itemIds: string[]): void {
  const sorted = [...itemIds].sort().join(",");
  db.prepare(
    "INSERT OR REPLACE INTO last_alerted_top3 (entry_key, item_ids, updated_at) VALUES (?, ?, ?)"
  ).run(entryKey, sorted, Date.now());
}

export default db;
