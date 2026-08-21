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

// Anti-spam : une carte très demandée peut avoir des dizaines d'annonces neuves dans un
// même cycle (relances, revendeurs multiples...). Au-delà de ce seuil, on n'alerte que sur
// les moins chères pour garder un volume de notifications Discord gérable — le reste est
// tout de même marqué "vu" pour ne pas revenir dessus au cycle suivant.
const MAX_ALERTS_PER_ENTRY = 5;

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
// que les `maxAlertsPerEntry` moins chères ; le reste doit tout de même être marqué "vu"
// par l'appelant pour ne pas revenir dessus au cycle suivant.
export function selectAlertsWithinCap(
  candidates: Candidate[],
  maxAlertsPerEntry: number
): { toAlert: Candidate[]; ignored: Candidate[] } {
  const sorted = [...candidates].sort((a, b) => a.item.price - b.item.price);
  return {
    toAlert: sorted.slice(0, maxAlertsPerEntry),
    ignored: sorted.slice(maxAlertsPerEntry),
  };
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

  // 1er passage : dédup (seen_items) + filtre langue. Les non-FR et déjà-vues sont
  // immédiatement marquées vues, tout le reste devient candidat à une alerte.
  const candidates: Candidate[] = [];

  for (const { source, mode, item } of sourcedItems) {
    // Les itemId sont propres à chaque marketplace : on les préfixe par source pour
    // éviter qu'un id Vinted et un id eBay identiques ne se marquent l'un l'autre "vu".
    const seenKey = `${source}:${item.itemId}`;
    if (hasSeenItem(seenKey)) continue;

    const { isFrench, reason } = isFrenchTitle(item.title, mode);
    if (!isFrench) {
      markItemSeen(seenKey, item.title, item.price);
      continue;
    }

    candidates.push({ source, seenKey, item, reason });
  }

  if (candidates.length === 0) return;

  // 2e passage : anti-spam. Au-delà du seuil, seules les moins chères sont alertées.
  const { toAlert, ignored } = selectAlertsWithinCap(candidates, MAX_ALERTS_PER_ENTRY);

  if (ignored.length > 0) {
    console.log(
      `[scheduler] ${candidates.length} annonces pour ${entry.name}, ${toAlert.length} alertes envoyées (moins chères), ${ignored.length} ignorées (spam commun)`
    );
  }

  for (const { source, seenKey, item, reason } of toAlert) {
    console.log(`[scheduler] nouvelle annonce (${source}): "${item.title}" à ${item.price}€ (${reason})`);
    try {
      await sendNewListingAlert(item);
    } catch (err) {
      console.error(`[scheduler] échec envoi Discord pour ${seenKey}:`, err);
    }
    markItemSeen(seenKey, item.title, item.price);
  }

  // Toujours dédupliquer via seen_items, même les annonces ignorées pour cause de spam :
  // on ne veut pas les revoir au cycle suivant.
  for (const { seenKey, item } of ignored) {
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
