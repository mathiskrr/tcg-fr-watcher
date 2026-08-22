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
// comparaison de classement : on stocke le dernier top 3 réellement envoyé par entrée+source,
// pour savoir si le classement a changé d'un cycle à l'autre (voir scheduler.ts). Tables
// héritées nettoyées si présentes (base de dev locale, pas de migration de données à
// préserver) : "last_alerted_top3" (ids seuls, sans messageId) est remplacée par
// "last_alerted_items" qui garde aussi l'id du message Discord de chaque item, nécessaire
// pour pouvoir supprimer le message d'une annonce sortie du top 3 (voir discord.ts
// deleteListingAlert) au lieu de se contenter de ne plus la renvoyer.
db.exec(`
  DROP TABLE IF EXISTS seen_items;
  DROP TABLE IF EXISTS last_alerted_top3;

  CREATE TABLE IF NOT EXISTS last_alerted_items (
    entry_key TEXT PRIMARY KEY,
    items TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export interface AlertedItem {
  itemKey: string;
  messageId: string;
}

// items : JSON [{itemKey, messageId}] -- le messageId permet de supprimer le message Discord
// d'un item qui sort du top 3 (voir scheduler.ts / discord.ts deleteListingAlert).
export function getLastAlertedItems(entryKey: string): AlertedItem[] | null {
  const row = db.prepare("SELECT items FROM last_alerted_items WHERE entry_key = ?").get(entryKey) as
    | { items: string }
    | undefined;

  if (!row) return null;
  return JSON.parse(row.items) as AlertedItem[];
}

export function setLastAlertedItems(entryKey: string, items: AlertedItem[]): void {
  db.prepare(
    "INSERT OR REPLACE INTO last_alerted_items (entry_key, items, updated_at) VALUES (?, ?, ?)"
  ).run(entryKey, JSON.stringify(items), Date.now());
}

export default db;
