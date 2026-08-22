import { readFileSync } from "node:fs";
import cron from "node-cron";
import { config } from "./config.js";
import { searchEbay } from "./ebay.js";
import { searchVinted } from "./vinted.js";
import { isFrenchTitle, isSealed, isSealedProductEntry, type LanguageFilterMode } from "./matcher.js";
import { getLastAlertedItems, setLastAlertedItems, type AlertedItem } from "./db.js";
import { sendNewListingAlert, deleteListingAlert } from "./discord.js";
import type { MarketplaceItem } from "./types.js";

export interface WatchlistEntry {
  name: string;
  set: string;
  ebayQuery: string;
  // Requête Vinted dédiée ; si absente/null, retombe sur ebayQuery.
  // Peut être un tableau de variantes (ex: ["... ME05 ...", "... ME5 ..."]) : les vendeurs
  // Vinted n'utilisent pas tous la même convention pour le numéro de set (zéro de tête ou
  // non), et le search_text de Vinted ne fait pas ce rapprochement lui-même (voir
  // isRelevantToQuery / fetchVintedItems) -> chaque variante est interrogée séparément puis
  // les résultats sont fusionnés (dédupliqués par itemId).
  vintedQuery?: string | string[] | null;
}

// Chaque cycle recalcule intégralement les TOP_N_PER_ENTRY annonces FR les moins chères
// actuellement disponibles pour l'entrée, sur l'ensemble des résultats du cycle (pas de
// dédup par item individuel). Anti-spam PAR ITEM (pas par "tout ou rien" du top 3 entier) :
// un item qui reste dans le top 3 d'un cycle à l'autre garde son message Discord existant
// (pas de renvoi) ; un item qui en SORT voit son message supprimé (voir deleteListingAlert) ;
// seul un item qui y ENTRE nouvellement déclenche un envoi — voir diffAlertedItems / db.ts
// last_alerted_items (stocke aussi le messageId Discord de chaque item pour pouvoir le
// supprimer).
// Le classement est fait PAR SOURCE (3 moins chères eBay + 3 moins chères Vinted,
// séparément, avec leur propre historique d'alertes) et non sur un pool combiné : les deux
// marketplaces ont des dynamiques de prix différentes, mélanger reviendrait à laisser l'une
// éclipser systématiquement l'autre.
const TOP_N_PER_ENTRY = 3;

function loadWatchlist(): WatchlistEntry[] {
  const raw = readFileSync(config.watchlistPath, "utf-8");
  return JSON.parse(raw) as WatchlistEntry[];
}

// Chaque source est interrogée indépendamment : un incident sur l'une (ex: eBay pas
// encore approuvé, Vinted qui bloque) ne doit pas empêcher les autres de tourner.
async function fetchSourceItems(
  source: string,
  entryName: string,
  fn: () => Promise<MarketplaceItem[]>
): Promise<MarketplaceItem[]> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[scheduler] recherche ${source} échouée pour "${entryName}":`, err);
    return [];
  }
}

export interface Candidate {
  source: string;
  itemKey: string;
  item: MarketplaceItem;
  reason: string;
}

// Fonction pure (pas d'I/O) pour rester testable isolément, sans dépendre de config.ts /
// db.ts / du réseau comme le reste de scheduler.ts. Trie par prix croissant et ne retient
// que les `n` moins chères.
export function selectCheapestN(items: Candidate[], n: number): Candidate[] {
  return [...items].sort((a, b) => a.item.price - b.item.price).slice(0, n);
}

export interface AlertDiff {
  // Items précédemment alertés qui ne sont plus dans le top N courant -> leur message Discord
  // doit être supprimé (voir deleteListingAlert).
  toDelete: AlertedItem[];
  // Items du top N courant qui n'étaient pas alertés précédemment -> doivent être envoyés.
  toAdd: Candidate[];
  // Items présents dans le top N courant ET précédemment alertés -> rien à faire, on garde
  // simplement leur messageId existant pour la prochaine comparaison.
  toKeep: AlertedItem[];
}

// Fonction pure (pas d'I/O) : compare le top N courant au dernier état réellement envoyé pour
// cette entrée+source, et retourne les 3 sous-ensembles à traiter. Comparaison en ENSEMBLE :
// seule la composition du top N compte (quels items en font partie), pas l'ordre entre eux ni
// leur rang de prix exact -- un item qui reste dans le top N même reclassé par le prix ne
// redéclenche ni envoi ni suppression (voir toKeep). `previous === null` (jamais alerté pour
// cette entrée+source) : tout le top N courant est neuf (aucun toDelete/toKeep possible).
export function diffAlertedItems(current: Candidate[], previous: AlertedItem[] | null): AlertDiff {
  const previousItems = previous ?? [];
  const previousByKey = new Map(previousItems.map((p) => [p.itemKey, p]));
  const currentKeys = new Set(current.map((c) => c.itemKey));

  return {
    toDelete: previousItems.filter((p) => !currentKeys.has(p.itemKey)),
    toAdd: current.filter((c) => !previousByKey.has(c.itemKey)),
    toKeep: previousItems.filter((p) => currentKeys.has(p.itemKey)),
  };
}

// Filtre langue (+ produit scellé le cas échéant) sur TOUS les résultats d'une source pour
// un cycle : le top N se recalcule à chaque cycle sur l'ensemble des résultats, sans dédup
// par item individuel (voir alertCheapestForSource pour la logique anti-spam au niveau du
// top 3 dans son ensemble).
function filterFrenchMatches(
  source: string,
  mode: LanguageFilterMode,
  items: MarketplaceItem[],
  entryName: string
): Candidate[] {
  const requireSealed = isSealedProductEntry(entryName);
  const matches: Candidate[] = [];

  for (const item of items) {
    const { isFrench, reason } = isFrenchTitle(item.title, mode);
    if (!isFrench) continue;

    // Pour une entrée "produit scellé" (Display, ETB, Bundle, Tripack, Booster...), une
    // annonce indiquant explicitement que le produit est ouvert/incomplet est écartée.
    if (requireSealed && !isSealed(item.title)) continue;

    // Les itemId sont propres à chaque marketplace : on les préfixe par source pour éviter
    // qu'un id Vinted et un id eBay identiques ne soient confondus dans le top 3 stocké.
    matches.push({ source, itemKey: `${source}:${item.itemId}`, item, reason });
  }
  return matches;
}

// Calcule le top N moins chères pour UNE source et ne touche Discord que pour les items dont
// la présence dans ce top N a changé depuis le dernier cycle (voir diffAlertedItems) : envoi
// pour les nouveaux entrants, suppression du message pour ceux qui en sont sortis, rien pour
// ceux qui y restent.
async function alertCheapestForSource(entry: WatchlistEntry, source: string, matches: Candidate[]): Promise<void> {
  if (matches.length === 0) return;

  const cheapest = selectCheapestN(matches, TOP_N_PER_ENTRY);
  const entryKey = `${source}:${entry.name}`;
  const previous = getLastAlertedItems(entryKey);
  const { toDelete, toAdd, toKeep } = diffAlertedItems(cheapest, previous);

  if (toDelete.length === 0 && toAdd.length === 0) {
    console.log(`[scheduler] top ${cheapest.length} (${source}) inchangé pour ${entry.name}, aucune alerte`);
    return;
  }

  console.log(
    `[scheduler] top ${cheapest.length} (${source}) modifié pour ${entry.name} — ${toAdd.length} nouvelle(s) alerte(s), ${toDelete.length} message(s) obsolète(s) à supprimer`
  );

  for (const { itemKey, messageId } of toDelete) {
    console.log(`[scheduler] suppression du message Discord pour ${itemKey} (${source}, sorti du top ${cheapest.length})`);
    try {
      await deleteListingAlert(messageId);
    } catch (err) {
      console.error(`[scheduler] échec suppression Discord pour ${itemKey}:`, err);
    }
  }

  const added: AlertedItem[] = [];
  for (const { itemKey, item, reason } of toAdd) {
    console.log(`[scheduler] nouvelle annonce du top ${cheapest.length} (${source}): "${item.title}" à ${item.price}€ (${reason})`);
    try {
      const messageId = await sendNewListingAlert(item, entry);
      added.push({ itemKey, messageId });
    } catch (err) {
      console.error(`[scheduler] échec envoi Discord pour ${itemKey}:`, err);
    }
  }

  // Un envoi/suppression en échec (catch ci-dessus) est simplement omis ici : il sera
  // retenté au prochain cycle tant que l'item reste dans le top N (toAdd) ou en est sorti
  // (toDelete, car absent de toKeep+added donc plus suivi -> considéré déjà "supprimé").
  setLastAlertedItems(entryKey, [...toKeep, ...added]);
}

// Normalise vintedQuery (string | string[] | null) en tableau non vide, avec repli sur
// ebayQuery si absente. Fonction pure, exportée pour être testable isolément.
export function vintedQueries(entry: Pick<WatchlistEntry, "vintedQuery" | "ebayQuery">): string[] {
  const query = entry.vintedQuery ?? entry.ebayQuery;
  return Array.isArray(query) ? query : [query];
}

// Fusionne les résultats de plusieurs variantes de requête en dédupliquant par itemId (une
// même annonce peut matcher plusieurs variantes). Fonction pure, exportée pour être testable
// isolément (voir vintedQueries pour pourquoi plusieurs variantes existent).
export function dedupeByItemId(itemLists: MarketplaceItem[][]): MarketplaceItem[] {
  const seen = new Set<string>();
  const merged: MarketplaceItem[] = [];

  for (const items of itemLists) {
    for (const item of items) {
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      merged.push(item);
    }
  }

  return merged;
}

// Interroge chaque variante de requête séparément (voir WatchlistEntry.vintedQuery), chacune
// isolée par fetchSourceItems : l'échec d'une seule n'empêche pas les autres de contribuer
// leurs résultats.
async function fetchVintedItems(entry: WatchlistEntry): Promise<MarketplaceItem[]> {
  const itemLists = await Promise.all(
    vintedQueries(entry).map((query) => fetchSourceItems("Vinted", entry.name, () => searchVinted(query)))
  );
  return dedupeByItemId(itemLists);
}

async function checkEntry(entry: WatchlistEntry): Promise<void> {
  const ebayItems = config.enabledSources.includes("ebay")
    ? await fetchSourceItems("eBay", entry.name, () => searchEbay(entry.ebayQuery))
    : [];
  const vintedItems = config.enabledSources.includes("vinted") ? await fetchVintedItems(entry) : [];

  // eBay est un marché international : un vendeur y précise explicitement la langue,
  // donc l'absence d'indice reste suspecte (mode "strict"). Vinted est déjà 100%
  // francophone par défaut : un titre sans indice de langue y est la norme, pas une
  // anomalie (mode "assume-french") — voir matcher.ts pour le détail des deux modes.
  const ebayMatches = filterFrenchMatches("ebay", "strict", ebayItems, entry.name);
  const vintedMatches = filterFrenchMatches("vinted", "assume-french", vintedItems, entry.name);

  // Classement et alertes indépendants par source (voir commentaire sur TOP_N_PER_ENTRY).
  await alertCheapestForSource(entry, "ebay", ebayMatches);
  await alertCheapestForSource(entry, "vinted", vintedMatches);
}

// Horodatage du dernier cycle complet, en mémoire (voir GET /status dans server.ts) : permet
// de vérifier à distance que le bot tourne toujours sans avoir à lire les logs/SSH.
let lastCycleCompletedAt: number | null = null;

export function getLastCycleCompletedAt(): number | null {
  return lastCycleCompletedAt;
}

// Nombre d'entrées actives de la watchlist (voir GET /status dans server.ts). Relit le
// fichier à chaque appel (comme loadWatchlist) : appelé rarement (une requête HTTP manuelle),
// pas besoin de mise en cache.
export function getActiveWatchlistCount(): number {
  return loadWatchlist().length;
}

export async function runCheck(): Promise<void> {
  const watchlist = loadWatchlist();
  console.log(
    `[scheduler] cycle de vérification démarré (${watchlist.length} entrées, sources: ${config.enabledSources.join(", ")})`
  );

  for (const entry of watchlist) {
    try {
      await checkEntry(entry);
    } catch (err) {
      console.error(`[scheduler] erreur inattendue sur "${entry.name}":`, err);
    }
  }

  lastCycleCompletedAt = Date.now();
  console.log("[scheduler] cycle de vérification terminé");
}

export function startScheduler(): void {
  cron.schedule(config.cronSchedule, () => {
    runCheck().catch((err) => console.error("[scheduler] erreur cycle cron:", err));
  });
  console.log(`[scheduler] cron démarré (${config.cronSchedule})`);
}
