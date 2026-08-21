import { config } from "./config.js";
import { fetchWithRetry } from "./http.js";

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

export interface EbayItem {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string | null;
}

// Le token OAuth "client credentials" est valide ~2h. On le garde en mémoire process
// et on le regénère seulement quand il approche de l'expiration.
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }

  // eBay attend les identifiants en Basic Auth (base64 "appId:certId") + grant_type client_credentials.
  const basicAuth = Buffer.from(`${config.ebayAppId}:${config.ebayCertId}`).toString("base64");

  const res = await fetchWithRetry(OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!res.ok) {
    throw new Error(`eBay OAuth a échoué: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };

  cachedToken = {
    accessToken: data.access_token,
    // Marge de sécurité de 60s avant l'expiration réelle.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return cachedToken.accessToken;
}

interface BrowseApiResponse {
  itemSummaries?: Array<{
    itemId: string;
    title: string;
    price?: { value: string; currency: string };
    itemWebUrl: string;
    image?: { imageUrl: string };
  }>;
}

// Recherche eBay Browse API sur le marketplace FR, catégorie "Cartes à collectionner".
export async function searchEbay(query: string, limit = 50): Promise<EbayItem[]> {
  const token = await getAccessToken();

  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  // 183454 = catégorie eBay "Cartes à collectionner CCG individuelles"
  url.searchParams.set("category_ids", "183454");

  const res = await fetchWithRetry(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR",
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`eBay Browse API a échoué: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as BrowseApiResponse;

  return (data.itemSummaries ?? [])
    .filter((item) => item.price)
    .map((item) => ({
      itemId: item.itemId,
      title: item.title,
      price: Number(item.price!.value),
      currency: item.price!.currency,
      url: item.itemWebUrl,
      imageUrl: item.image?.imageUrl ?? null,
    }));
}
