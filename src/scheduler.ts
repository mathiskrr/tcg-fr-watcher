import { readFileSync } from "node:fs";
import cron from "node-cron";
import { config } from "./config.js";
import { searchEbay } from "./ebay.js";
import { searchVinted } from "./vinted.js";
import { isFrenchTitle, type LanguageFilterMode } from "./matcher.js";
import { hasSeenItem, markItemSeen } from "./db.js";
import { sendNewListingAlert } from "./discord.js";
import type { MarketplaceItem } from "./types.js";

export interface WatchlistEntry {
  name: string;
  set: string;
  ebayQuery: string;
  // Requête Vinted dédiée ; si absente/null, retombe sur ebayQuery.
  vintedQuery?: string | null;
}

// Chaque cycle remonte systématiquement les TOP_N_PER_ENTRY annonces FR les moins
// chères actuellement disponibles pour l'entrée — pas seulement les nouvelles : le
// classement se recalcule intégralement à chaque cycle sur l'ensemble des résultats.
// La dédup via seen_items sert uniquement à ne pas ré-alerter une annonce déjà notifiée
// (ex: elle reste dans le top 3 d'un cycle à l'autre).
// Le classement est fait PAR SOURCE (3 moins chères eBay + 3 moins chères Vinted,
// séparément) et non sur un pool combiné : les deux marketplaces ont des dynamiques de
// prix différentes, mélanger reviendrait à laisser l'une éclipser systématiquement l'autre.
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
  seenKey: string;
  item: MarketplaceItem;
  reason: string;
}

// Fonction pure (pas d'I/O) pour rester testable isolément, sans dépendre de config.ts /
// db.ts / du réseau comme le reste de scheduler.ts. Trie par prix croissant et ne retient
// que les `n` moins chères, indépendamment de leur statut "vu" ou non — ce filtrage-là est
// fait séparément, après coup, par l'appelant (voir checkEntry).
export function selectCheapestN(items: Candidate[], n: number): Candidate[] {
  return [...items].sort((a, b) => a.item.price - b.item.price).slice(0, n);
}

// Filtre langue sur TOUS les résultats d'une source pour un cycle (pas de dédup ici :
// le top N doit se recalculer à chaque cycle sur tous les résultats, vus ou non).
function filterFrenchMatches(source: string, mode: LanguageFilterMode, items: MarketplaceItem[]): Candidate[] {
  const matches: Candidate[] = [];
  for (const item of items) {
    const { isFrench, reason } = isFrenchTitle(item.title, mode);
    if (!isFrench) continue;

    // Les itemId sont propres à chaque marketplace : on les préfixe par source pour
    // éviter qu'un id Vinted et un id eBay identiques ne se marquent l'un l'autre "vu".
    matches.push({ source, seenKey: `${source}:${item.itemId}`, item, reason });
  }
  return matches;
}

// Calcule et envoie les alertes pour UNE source : top N moins chères parmi tous ses
// résultats du cycle, puis dédup via seen_items pour ne (re)notifier que les nouvelles.
async function alertCheapestForSource(entryName: string, source: string, matches: Candidate[]): Promise<void> {
  if (matches.length === 0) return;

  const cheapest = selectCheapestN(matches, TOP_N_PER_ENTRY);
  const toAlert = cheapest.filter((c) => !hasSeenItem(c.seenKey));
  const alreadyAlerted = cheapest.length - toAlert.length;

  console.log(
    `[scheduler] ${matches.length} annonce(s) FR (${source}) pour ${entryName}, top ${cheapest.length} moins chère(s) : ${toAlert.length} nouvelle(s) alerte(s), ${alreadyAlerted} déjà alertée(s) précédemment`
  );

  for (const { seenKey, item, reason } of toAlert) {
    console.log(`[scheduler] nouvelle annonce (${source}): "${item.title}" à ${item.price}€ (${reason})`);
    try {
      await sendNewListingAlert(item);
    } catch (err) {
      console.error(`[scheduler] échec envoi Discord pour ${seenKey}:`, err);
    }
    markItemSeen(seenKey, item.title, item.price);
  }
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
  const ebayMatches = filterFrenchMatches("ebay", "strict", ebayItems);
  const vintedMatches = filterFrenchMatches("vinted", "assume-french", vintedItems);

  // Classement et alertes indépendants par source (voir commentaire sur TOP_N_PER_ENTRY).
  await alertCheapestForSource(entry.name, "ebay", ebayMatches);
  await alertCheapestForSource(entry.name, "vinted", vintedMatches);
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
