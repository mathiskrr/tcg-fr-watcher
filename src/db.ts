import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

// node:sqlite (module intégré à Node, stable depuis 22.5) est utilisé à la place
// de better-sqlite3 pour éviter une compilation native (node-gyp) côté install.
const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_items (
    item_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    price REAL NOT NULL,
    seen_at INTEGER NOT NULL
  );
`);

export function hasSeenItem(itemId: string): boolean {
  const row = db.prepare("SELECT 1 FROM seen_items WHERE item_id = ?").get(itemId);
  return row !== undefined;
}

export function markItemSeen(itemId: string, title: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO seen_items (item_id, title, price, seen_at) VALUES (?, ?, ?, ?)"
  ).run(itemId, title, price, Date.now());
}

export default db;
