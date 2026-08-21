import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante: ${name} (voir .env.example)`);
  }
  return value;
}

export const config = {
  ebayAppId: required("EBAY_APP_ID"),
  ebayCertId: required("EBAY_CERT_ID"),
  discordWebhookUrl: required("DISCORD_WEBHOOK_URL"),
  priceThreshold: Number(process.env.PRICE_THRESHOLD ?? "0.7"),
  cronSchedule: process.env.CRON_SCHEDULE ?? "*/10 * * * *",
  dbPath: process.env.DB_PATH ?? "./data/watcher.sqlite",
  watchlistPath: process.env.WATCHLIST_PATH ?? "./watchlist.json",
  // Cookie de session Vinted (JWT), à récupérer manuellement (pas d'API officielle) :
  // connecté sur vinted.fr, DevTools > Application/Storage > Cookies > "access_token_web".
  // Optionnel : sans lui, les requêtes Vinted échouent généralement en 401 (voir vinted.ts).
  vintedAccessTokenWeb: process.env.VINTED_ACCESS_TOKEN_WEB || null,
};

export type Config = typeof config;
