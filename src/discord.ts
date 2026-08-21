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

export async function sendNewListingAlert(
  item: MarketplaceItem,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS
): Promise<void> {
  await waitForRateLimit(minIntervalMs);

  const embed = {
    title: item.title,
    url: item.url,
    color: 0x2ecc71,
    thumbnail: item.imageUrl ? { url: item.imageUrl } : undefined,
    fields: [{ name: "Prix", value: `${item.price.toFixed(2)} €`, inline: true }],
    footer: { text: `item ${item.itemId}` },
  };

  const res = await fetchWithRetry(config.discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    throw new Error(`Envoi webhook Discord échoué: ${res.status} ${await res.text()}`);
  }
}
