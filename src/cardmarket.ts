import { fetchWithRetry } from "./http.js";
import { getCachedPrice, setCachedPrice } from "./db.js";
import type { WatchlistEntry } from "./scheduler.js";

// Cardmarket n'a pas d'API publique simple d'accès (l'API officielle nécessite un
// partenariat marchand + OAuth1). En V1 on fait du scraping léger : on lit la page
// produit publique et on extrait le "Prix moyen" via une regex sur le HTML.
// NB: fragile par nature (dépend du markup Cardmarket) -> mis en cache 24h (voir db.ts)
// et toujours contournable en fixant "referencePrice" en dur dans watchlist.json.
const AVERAGE_PRICE_PATTERN = /Prix moyen[\s\S]{0,200}?([\d]+[.,]\d{2})\s*€/i;

async function scrapeCardmarketAveragePrice(url: string): Promise<number | null> {
  const res = await fetchWithRetry(url, {
    headers: {
      // Cardmarket bloque les requêtes sans User-Agent "navigateur".
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "fr-FR,fr;q=0.9",
    },
  });

  if (!res.ok) {
    console.warn(`[cardmarket] échec fetch ${url}: HTTP ${res.status}`);
    return null;
  }

  const html = await res.text();
  const match = html.match(AVERAGE_PRICE_PATTERN);
  if (!match) {
    console.warn(`[cardmarket] prix moyen introuvable dans la page ${url}`);
    return null;
  }

  return Number(match[1].replace(",", "."));
}

// Résout le prix de référence d'une entrée watchlist :
// 1. referencePrice fixe dans watchlist.json si présent (prioritaire, pas de réseau)
// 2. sinon cache SQLite (price_cache) si encore valide (24h)
// 3. sinon scraping Cardmarket, puis mise en cache
export async function getReferencePrice(entry: WatchlistEntry): Promise<number | null> {
  if (typeof entry.referencePrice === "number") {
    return entry.referencePrice;
  }

  if (!entry.cardmarketUrl) {
    return null;
  }

  const cacheKey = entry.cardmarketUrl;
  const cached = getCachedPrice(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const price = await scrapeCardmarketAveragePrice(entry.cardmarketUrl);
  if (price !== null) {
    setCachedPrice(cacheKey, price);
  }
  return price;
}
