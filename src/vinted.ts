import { config } from "./config.js";
import { fetchWithRetry } from "./http.js";
import type { MarketplaceItem } from "./types.js";

export type VintedItem = MarketplaceItem;

// Vinted n'a pas d'API publique documentée : on appelle ici l'endpoint interne utilisé
// par leur propre frontend web (catalog/items). Fragile par nature (peut changer sans
// préavis) et potentiellement bloqué (403/429) si le trafic est jugé automatisé -> voir
// isBlockedStatus / le retry dédié plus bas. Nécessite en pratique un cookie de session
// valide (access_token_web), sans quoi l'API répond 401 même avec des en-têtes
// navigateur réalistes -> voir renderRenewalInstructions ci-dessous.
const SEARCH_URL = "https://www.vinted.fr/api/v2/catalog/items";

// Id de catégorie Vinted "Cartes à collectionner" (Loisirs créatifs > Jeux, jouets).
// A confirmer/ajuster en inspectant les requêtes réseau du site (onglet Network) si les
// résultats remontent hors-catégorie : l'arborescence des catalog_ids peut changer côté Vinted.
export const COLLECTIBLE_CARDS_CATALOG_ID = "3025";

// En-têtes imitant un navigateur classique. Ça n'annule pas une éventuelle protection
// anti-bot côté Vinted, mais évite les rejets triviaux liés à l'absence de User-Agent / Referer.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "fr-FR,fr;q=0.9",
  Referer: "https://www.vinted.fr/catalog",
};

const RENEWAL_INSTRUCTIONS =
  'connecte-toi sur vinted.fr, ouvre les DevTools du navigateur (F12) > Application/Storage > ' +
  'Cookies > https://www.vinted.fr, copie la valeur du cookie "access_token_web", mets à jour ' +
  "VINTED_ACCESS_TOKEN_WEB dans .env, puis redémarre le bot.";

function isBlockedStatus(status: number): boolean {
  return status === 403 || status === 429;
}

// access_token_web est un JWT. On décode juste son payload (aucune vérif de signature :
// on ne fait pas confiance au contenu, on veut seulement lire la date d'expiration pour
// prévenir avant même d'envoyer la requête). Retourne null si le format est inattendu.
export function decodeJwtExpiry(token: string): number | null {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const json = Buffer.from(payloadPart, "base64url").toString("utf-8");
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function warnIfAccessTokenLooksExpired(token: string): void {
  const expiresAt = decodeJwtExpiry(token);
  if (expiresAt !== null && Date.now() >= expiresAt) {
    console.warn(
      `[vinted] le cookie access_token_web semble expiré (expiration détectée: ${new Date(
        expiresAt
      ).toISOString()}) — ${RENEWAL_INSTRUCTIONS}`
    );
  }
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

// retries/delayMsBase/accessTokenWeb exposés (au lieu d'être en dur) pour permettre des
// tests rapides et déterministes sans dépendre de config.ts ni du vrai backoff.
export async function searchVinted(
  query: string,
  limit = 50,
  retries = 3,
  delayMsBase = 1500,
  accessTokenWeb: string | null = config.vintedAccessTokenWeb
): Promise<VintedItem[]> {
  const headers: Record<string, string> = { ...BROWSER_HEADERS };

  if (accessTokenWeb) {
    warnIfAccessTokenLooksExpired(accessTokenWeb);
    headers.Cookie = `access_token_web=${accessTokenWeb}`;
  }

  const url = new URL(SEARCH_URL);
  url.searchParams.set("search_text", query);
  url.searchParams.set("catalog_ids", COLLECTIBLE_CARDS_CATALOG_ID);
  url.searchParams.set("order", "newest_first");
  url.searchParams.set("per_page", String(limit));

  const res = await fetchWithRetry(
    url.toString(),
    { headers },
    retries,
    delayMsBase,
    (status) => status >= 500 || isBlockedStatus(status)
  );

  if (!res.ok) {
    if (res.status === 401) {
      console.error(`[vinted] session invalide ou expirée (HTTP 401) — ${RENEWAL_INSTRUCTIONS}`);
    } else if (isBlockedStatus(res.status)) {
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
