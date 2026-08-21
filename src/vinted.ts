import { fetchWithRetry } from "./http.js";
import type { MarketplaceItem } from "./types.js";

export type VintedItem = MarketplaceItem;

// Vinted n'a pas d'API publique documentée : on appelle ici l'endpoint interne utilisé
// par leur propre frontend web (catalog/items). Fragile par nature (peut changer sans
// préavis) et potentiellement bloqué (403/429) si le trafic est jugé automatisé -> voir
// isBlockedStatus / le retry dédié plus bas.
const SEARCH_URL = "https://www.vinted.fr/api/v2/catalog/items";

// Id de catégorie Vinted "Cartes à collectionner" (Loisirs créatifs > Jeux, jouets).
// A confirmer/ajuster en inspectant les requêtes réseau du site (onglet Network) si les
// résultats remontent hors-catégorie : l'arborescence des catalog_ids peut changer côté Vinted.
export const COLLECTIBLE_CARDS_CATALOG_ID = "3025";

// En-têtes imitant un navigateur classique. Ça n'annule pas une éventuelle protection
// anti-bot côté Vinted (ex: exigence de cookies de session obtenus via une vraie page vue),
// mais évite les rejets triviaux liés à l'absence de User-Agent / Referer.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "fr-FR,fr;q=0.9",
  Referer: "https://www.vinted.fr/catalog",
};

function isBlockedStatus(status: number): boolean {
  return status === 403 || status === 429;
}

interface VintedApiResponse {
  items?: Array<{
    id: number;
    title: string;
    price?: { amount: string; currency_code: string };
    url?: string;
    photo?: { url: string } | null;
  }>;
}

// retries/delayMsBase exposés (au lieu d'être en dur) pour permettre des tests rapides
// du chemin de retry sans attendre le vrai backoff en production.
export async function searchVinted(
  query: string,
  limit = 50,
  retries = 3,
  delayMsBase = 1500
): Promise<VintedItem[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("search_text", query);
  url.searchParams.set("catalog_ids", COLLECTIBLE_CARDS_CATALOG_ID);
  url.searchParams.set("order", "newest_first");
  url.searchParams.set("per_page", String(limit));

  const res = await fetchWithRetry(
    url.toString(),
    { headers: BROWSER_HEADERS },
    retries,
    delayMsBase,
    (status) => status >= 500 || isBlockedStatus(status)
  );

  if (!res.ok) {
    if (isBlockedStatus(res.status)) {
      console.warn(
        `[vinted] blocage anti-bot probable (HTTP ${res.status}) après ${retries} tentative(s), requête ignorée pour ce cycle`
      );
    }
    throw new Error(`Vinted API a échoué: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as VintedApiResponse;

  return (data.items ?? [])
    .filter((item) => item.price)
    .map((item) => ({
      itemId: String(item.id),
      title: item.title,
      price: Number(item.price!.amount),
      currency: item.price!.currency_code,
      url: item.url ?? `https://www.vinted.fr/items/${item.id}`,
      imageUrl: item.photo?.url ?? null,
    }));
}
