import { config } from "./config.js";
import { fetchWithRetry } from "./http.js";
import type { MarketplaceItem } from "./types.js";

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

function buildEmbed(item: MarketplaceItem) {
  return {
    title: item.title,
    url: item.url,
    color: 0x2ecc71,
    thumbnail: item.imageUrl ? { url: item.imageUrl } : undefined,
    fields: [{ name: "Prix", value: `${item.price.toFixed(2)} €`, inline: true }],
    footer: { text: `item ${item.itemId}` },
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
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS
): Promise<void> {
  await waitForRateLimit(minIntervalMs);

  const embed = buildEmbed(item);
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
