import { config } from "./config.js";
import { fetchWithRetry } from "./http.js";
import { isSealedProductEntry } from "./matcher.js";
import type { MarketplaceItem } from "./types.js";

// Contexte minimal nécessaire à l'embed (nom + set de l'entrée watchlist), sans dépendre du
// type WatchlistEntry de scheduler.ts (qui importe déjà sendNewListingAlert d'ici — éviter
// un import circulaire).
export interface AlertContext {
  name: string;
  set: string;
}

// Espace les envois vers le webhook Discord pour rester sous sa limite de taux (~5
// requêtes / 2s par webhook) quand plusieurs annonces sont détectées dans le même
// cycle. État partagé au niveau du module : peu importe l'appelant, les envois
// successifs sont automatiquement espacés d'au moins `minIntervalMs`.
const DEFAULT_MIN_INTERVAL_MS = 500;
let lastSentAt = 0;

async function waitForRateLimit(minIntervalMs: number): Promise<void> {
  const waitMs = minIntervalMs - (Date.now() - lastSentAt);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastSentAt = Date.now();
}

// Couleur + emoji selon la rareté détectable dans le nom de l'entrée watchlist. Vérifiés
// dans cet ordre : Gold/SIR (haut de gamme) avant AR/UR, avant le générique "scellé".
const COLOR_GOLD = 0xf1c40f;
const COLOR_PURPLE = 0x9b59b6;
const COLOR_BLUE = 0x3498db;
const COLOR_GREY = 0x95a5a6;

const GOLD_PATTERN = /\bgold\b/i;
const SIR_PATTERN = /\bsir\b/i;
const AR_OR_UR_PATTERN = /\b(ar|ur)\b/i;

interface RarityStyle {
  color: number;
  emojiPrefix: string;
}

function detectRarityStyle(entryName: string): RarityStyle {
  if (GOLD_PATTERN.test(entryName) || SIR_PATTERN.test(entryName)) {
    return { color: GOLD_PATTERN.test(entryName) ? COLOR_GOLD : COLOR_PURPLE, emojiPrefix: "🌟 " };
  }
  if (AR_OR_UR_PATTERN.test(entryName)) {
    return { color: COLOR_BLUE, emojiPrefix: "✨ " };
  }
  if (isSealedProductEntry(entryName)) {
    return { color: COLOR_GREY, emojiPrefix: "📦 " };
  }
  return { color: COLOR_GREY, emojiPrefix: "" };
}

// Toutes les annonces sont déjà filtrées FR en amont (matcher.ts) : le "(FR)" en fin de
// titre, quand un vendeur le met, n'apporte plus rien une fois dans l'embed.
const TRAILING_FR_TAG_PATTERN = /\s*\(fr\)\s*$/i;

function cleanTitle(title: string): string {
  return title.replace(TRAILING_FR_TAG_PATTERN, "").trim();
}

function buildEmbed(item: MarketplaceItem, entry: AlertContext) {
  const { color, emojiPrefix } = detectRarityStyle(entry.name);

  return {
    title: `${emojiPrefix}${cleanTitle(item.title)}`,
    url: item.url,
    color,
    thumbnail: item.imageUrl ? { url: item.imageUrl } : undefined,
    fields: [
      { name: "💰 Prix", value: `**${item.price.toFixed(2)} €**`, inline: true },
      // Footer Discord = texte brut (pas de lien cliquable) : le lien vit dans un field à
      // la place, en markdown, pour rester réellement cliquable.
      { name: "Annonce", value: `[🔗 Voir l'annonce](${item.url})`, inline: true },
    ],
    // `timestamp` (ISO8601) est un champ natif de l'embed Discord : combiné au footer, il
    // affiche "<set> • à l'instant" (ou l'heure exacte) sans avoir à le formater nous-mêmes.
    footer: { text: entry.set },
    timestamp: new Date().toISOString(),
  };
}

function postEmbed(embed: ReturnType<typeof buildEmbed>): Promise<Response> {
  return fetchWithRetry(config.discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

// Le corps d'une réponse 429 Discord contient `retry_after` en secondes (float).
// clone() est nécessaire : on ne veut pas consommer le body si l'appelant doit
// ensuite lire res.text() sur cette même réponse (cas où il n'y a pas de retry).
async function extractRetryAfterMs(res: Response): Promise<number | null> {
  try {
    const body = (await res.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number" && body.retry_after >= 0) {
      return Math.ceil(body.retry_after * 1000);
    }
  } catch {
    // corps non-JSON ou vide -> pas de retry_after exploitable
  }
  return null;
}

export async function sendNewListingAlert(
  item: MarketplaceItem,
  entry: AlertContext,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS
): Promise<void> {
  await waitForRateLimit(minIntervalMs);

  const embed = buildEmbed(item, entry);
  let res = await postEmbed(embed);
  let retried = false;

  // Rate-limit Discord (429) : on respecte exactement le retry_after qu'il indique
  // (jamais un délai arbitraire de notre cru), puis on retente une seule fois.
  if (res.status === 429) {
    const retryAfterMs = await extractRetryAfterMs(res);
    if (retryAfterMs !== null) {
      console.warn(
        `[discord] rate limit 429 pour l'item ${item.itemId} — attente de ${retryAfterMs}ms (retry_after indiqué par Discord) avant un unique nouvel essai`
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      res = await postEmbed(embed);
      retried = true;
    } else {
      console.error(`[discord] 429 reçu pour l'item ${item.itemId} sans retry_after exploitable, abandon`);
    }
  }

  if (!res.ok) {
    if (retried && res.status === 429) {
      console.error(`[discord] toujours rate limited (429) après le retry, abandon pour l'item ${item.itemId}`);
    }
    throw new Error(`Envoi webhook Discord échoué: ${res.status} ${await res.text()}`);
  }
}
