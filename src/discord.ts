import { config } from "./config.js";
import { fetchWithRetry } from "./http.js";
import type { EbayItem } from "./ebay.js";

export async function sendDealAlert(
  item: EbayItem,
  referencePrice: number,
  discountPercent: number
): Promise<void> {
  const embed = {
    title: item.title,
    url: item.url,
    color: 0x2ecc71,
    thumbnail: item.imageUrl ? { url: item.imageUrl } : undefined,
    fields: [
      { name: "Prix annonce", value: `${item.price.toFixed(2)} €`, inline: true },
      { name: "Prix référence (Cardmarket)", value: `${referencePrice.toFixed(2)} €`, inline: true },
      { name: "Écart", value: `-${discountPercent}%`, inline: true },
    ],
    footer: { text: `eBay item ${item.itemId}` },
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
