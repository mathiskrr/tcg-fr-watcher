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
  const sourcedItems: Array<{ source: string; mode: LanguageFilterMode; item: MarketplaceItem }> = [
    ...ebayItems.map((item) => ({ source: "ebay", mode: "strict" as const, item })),
    ...vintedItems.map((item) => ({ source: "vinted", mode: "assume-french" as const, item })),
  ];

  for (const { source, mode, item } of sourcedItems) {
    // Les itemId sont propres à chaque marketplace : on les préfixe par source pour
    // éviter qu'un id Vinted et un id eBay identiques ne se marquent l'un l'autre "vu".
    const seenKey = `${source}:${item.itemId}`;
    if (hasSeenItem(seenKey)) continue;

    const { isFrench, reason } = isFrenchTitle(item.title, mode);
    if (isFrench) {
      console.log(`[scheduler] nouvelle annonce (${source}): "${item.title}" à ${item.price}€ (${reason})`);
      try {
        await sendNewListingAlert(item);
      } catch (err) {
        console.error(`[scheduler] échec envoi Discord pour ${seenKey}:`, err);
      }
    }

    markItemSeen(seenKey, item.title, item.price);
  }
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
