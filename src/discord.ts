import { config } from "./config.js";
import { fetchWithRetry } from "./http.js";
import type { MarketplaceItem } from "./types.js";

export async function sendNewListingAlert(item: MarketplaceItem): Promise<void> {
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
