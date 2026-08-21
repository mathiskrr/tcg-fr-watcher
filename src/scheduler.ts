import { readFileSync } from "node:fs";
import cron from "node-cron";
import { config } from "./config.js";
import { searchEbay } from "./ebay.js";
import { getReferencePrice } from "./cardmarket.js";
import { evaluateDeal } from "./pricing.js";
import { isFrenchTitle } from "./matcher.js";
import { hasSeenItem, markItemSeen } from "./db.js";
import { sendDealAlert } from "./discord.js";

export interface WatchlistEntry {
  name: string;
  set: string;
  ebayQuery: string;
  cardmarketUrl: string | null;
  referencePrice: number | null;
}

function loadWatchlist(): WatchlistEntry[] {
  const raw = readFileSync(config.watchlistPath, "utf-8");
  return JSON.parse(raw) as WatchlistEntry[];
}

async function checkEntry(entry: WatchlistEntry): Promise<void> {
  const referencePrice = await getReferencePrice(entry);
  if (referencePrice === null) {
    console.warn(`[scheduler] pas de prix de référence pour "${entry.name}", entrée ignorée`);
    return;
  }

  let items;
  try {
    items = await searchEbay(entry.ebayQuery);
  } catch (err) {
    console.error(`[scheduler] recherche eBay échouée pour "${entry.name}":`, err);
    return;
  }

  for (const item of items) {
    if (hasSeenItem(item.itemId)) continue;

    const { isFrench, reason } = isFrenchTitle(item.title);
    if (!isFrench) {
      markItemSeen(item.itemId, item.title, item.price);
      continue;
    }

    const { isGoodDeal, discountPercent } = evaluateDeal(
      item.price,
      referencePrice,
      config.priceThreshold
    );

    if (isGoodDeal) {
      console.log(
        `[scheduler] bonne affaire détectée: "${item.title}" à ${item.price}€ (-${discountPercent}%, ${reason})`
      );
      try {
        await sendDealAlert(item, referencePrice, discountPercent);
      } catch (err) {
        console.error(`[scheduler] échec envoi Discord pour ${item.itemId}:`, err);
      }
    }

    markItemSeen(item.itemId, item.title, item.price);
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
