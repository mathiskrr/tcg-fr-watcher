import { readFileSync } from "node:fs";
import cron from "node-cron";
import { config } from "./config.js";
import { searchEbay } from "./ebay.js";
import { searchVinted } from "./vinted.js";
import { isFrenchTitle, isSealed, isSealedProductEntry, type LanguageFilterMode } from "./matcher.js";
import { getLastAlertedTop3, setLastAlertedTop3 } from "./db.js";
import { sendNewListingAlert } from "./discord.js";
import type { MarketplaceItem } from "./types.js";

export interface WatchlistEntry {
  name: string;
  set: string;
  ebayQuery: string;
  // Requête Vinted dédiée ; si absente/null, retombe sur ebayQuery.
  vintedQuery?: string | null;
}

// Chaque cycle recalcule intégralement les TOP_N_PER_ENTRY annonces FR les moins chères
// actuellement disponibles pour l'entrée, sur l'ensemble des résultats du cycle (pas de
// dédup par item individuel). Anti-spam : on ne (ré)envoie les 3 alertes que si la
// COMPOSITION du top 3 a changé depuis le dernier envoi pour cette entrée+source (un item
// différent y entre ou en sort) — voir hasTop3Changed / db.ts last_alerted_top3. Si le top 3
// est identique au dernier envoi (mêmes 3 items, peu importe l'ordre ou leur rang de prix
// exact entre eux), rien n'est renvoyé ce cycle-là.
// Le classement est fait PAR SOURCE (3 moins chères eBay + 3 moins chères Vinted,
// séparément, avec leur propre "dernier top 3 envoyé") et non sur un pool combiné : les deux
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

// Fonction pure : compare le top N courant (ids) au dernier top N réellement envoyé pour
// cette entrée+source. Comparaison en ENSEMBLE : seule la composition du top 3 compte (quels
// items en font partie), pas l'ordre entre eux ni leur rang de prix exact — un même trio
// d'items, même reclassé entre eux par le prix, ne redéclenche pas d'envoi. Un item qui
// entre ou sort du top 3 (nouvelle annonce moins chère, annonce vendue...) déclenche un envoi.
// `lastIds === null` (jamais envoyé pour cette entrée+source) compte toujours comme changé.
export function hasTop3Changed(currentIds: string[], lastIds: string[] | null): boolean {
  if (lastIds === null) return true;
  if (currentIds.length !== lastIds.length) return true;

  const lastSet = new Set(lastIds);
  return !currentIds.every((id) => lastSet.has(id));
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

// Calcule le top N moins chères pour UNE source et n'envoie les alertes que si sa
// composition a changé depuis le dernier envoi pour cette entrée+source (voir
// hasTop3Changed). Si elle a changé, les N alertes sont renvoyées EN ENTIER (pas seulement
// la différence), pour toujours voir les N vraies moins chères ensemble dans Discord.
async function alertCheapestForSource(entry: WatchlistEntry, source: string, matches: Candidate[]): Promise<void> {
  if (matches.length === 0) return;

  const cheapest = selectCheapestN(matches, TOP_N_PER_ENTRY);
  const entryKey = `${source}:${entry.name}`;
  const currentIds = cheapest.map((c) => c.itemKey);
  const lastIds = getLastAlertedTop3(entryKey);

  if (!hasTop3Changed(currentIds, lastIds)) {
    console.log(`[scheduler] top ${cheapest.length} (${source}) inchangé pour ${entry.name}, aucune alerte`);
    return;
  }

  console.log(
    `[scheduler] top ${cheapest.length} (${source}) modifié pour ${entry.name} — envoi des ${cheapest.length} alertes`
  );

  for (const { itemKey, item, reason } of cheapest) {
    console.log(`[scheduler] annonce du top ${cheapest.length} (${source}): "${item.title}" à ${item.price}€ (${reason})`);
    try {
      await sendNewListingAlert(item, entry);
    } catch (err) {
      console.error(`[scheduler] échec envoi Discord pour ${itemKey}:`, err);
    }
  }

  setLastAlertedTop3(entryKey, currentIds);
}

async function checkEntry(entry: WatchlistEntry): Promise<void> {
  const ebayItems = config.enabledSources.includes("ebay")
    ? await fetchSourceItems("eBay", entry.name, () => searchEbay(entry.ebayQuery))
    : [];
  const vintedItems = config.enabledSources.includes("vinted")
    ? await fetchSourceItems("Vinted", entry.name, () => searchVinted(entry.vintedQuery ?? entry.ebayQuery))
    : [];

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

  console.log("[scheduler] cycle de vérification terminé");
}

export function startScheduler(): void {
  cron.schedule(config.cronSchedule, () => {
    runCheck().catch((err) => console.error("[scheduler] erreur cycle cron:", err));
  });
  console.log(`[scheduler] cron démarré (${config.cronSchedule})`);
}
