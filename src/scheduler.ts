import { readFileSync } from "node:fs";
import cron from "node-cron";
import { config } from "./config.js";
import { searchEbay } from "./ebay.js";
import { searchVinted } from "./vinted.js";
import { getReferencePrice } from "./cardmarket.js";
import { evaluateDeal } from "./pricing.js";
import { isFrenchTitle } from "./matcher.js";
import { hasSeenItem, markItemSeen } from "./db.js";
import { sendDealAlert } from "./discord.js";
import type { MarketplaceItem } from "./types.js";

export interface WatchlistEntry {
  name: string;
  set: string;
  ebayQuery: string;
  // Requête Vinted dédiée ; si absente/null, retombe sur ebayQuery.
  vintedQuery?: string | null;
  cardmarketUrl: string | null;
  referencePrice: number | null;
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
  const referencePrice = await getReferencePrice(entry);
  if (referencePrice === null) {
    console.warn(`[scheduler] pas de prix de référence pour "${entry.name}", entrée ignorée`);
    return;
  }

  const ebayItems = await fetchSourceItems("eBay", entry.name, () => searchEbay(entry.ebayQuery));
  const vintedItems = await fetchSourceItems("Vinted", entry.name, () =>
    searchVinted(entry.vintedQuery ?? entry.ebayQuery)
  );

  const sourcedItems: Array<{ source: string; item: MarketplaceItem }> = [
    ...ebayItems.map((item) => ({ source: "ebay", item })),
    ...vintedItems.map((item) => ({ source: "vinted", item })),
  ];

  for (const { source, item } of sourcedItems) {
    // Les itemId sont propres à chaque marketplace : on les préfixe par source pour
    // éviter qu'un id Vinted et un id eBay identiques ne se marquent l'un l'autre "vu".
    const seenKey = `${source}:${item.itemId}`;
    if (hasSeenItem(seenKey)) continue;

    const { isFrench, reason } = isFrenchTitle(item.title);
    if (!isFrench) {
      markItemSeen(seenKey, item.title, item.price);
      continue;
    }

    const { isGoodDeal, discountPercent } = evaluateDeal(
      item.price,
      referencePrice,
      config.priceThreshold
    );

    if (isGoodDeal) {
      console.log(
        `[scheduler] bonne affaire détectée (${source}): "${item.title}" à ${item.price}€ (-${discountPercent}%, ${reason})`
      );
      try {
        await sendDealAlert(item, referencePrice, discountPercent);
      } catch (err) {
        console.error(`[scheduler] échec envoi Discord pour ${seenKey}:`, err);
      }
    }

    markItemSeen(seenKey, item.title, item.price);
  }
}

export async function runCheck(): Promise<void> {
  const watchlist = loadWatchlist();
  console.log(`[scheduler] cycle de vérification démarré (${watchlist.length} entrées)`);

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
