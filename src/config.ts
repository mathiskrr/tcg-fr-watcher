import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante: ${name} (voir .env.example)`);
  }
  return value;
}

export const VALID_SOURCES = ["ebay", "vinted"] as const;
export type Source = (typeof VALID_SOURCES)[number];

// Fonction pure (pas de lecture de process.env ici) pour rester testable isolément,
// sans dépendre du chargement du module config.ts (qui valide EBAY_APP_ID etc. au chargement).
export function parseEnabledSources(raw: string | undefined): Source[] {
  if (!raw || raw.trim() === "") {
    return [...VALID_SOURCES]; // par défaut : toutes les sources actives
  }

  const sources = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const invalid = sources.filter((s) => !(VALID_SOURCES as readonly string[]).includes(s));
  if (invalid.length > 0) {
    throw new Error(
      `ENABLED_SOURCES contient des valeurs inconnues: ${invalid.join(", ")} (valeurs valides: ${VALID_SOURCES.join(", ")})`
    );
  }

  if (sources.length === 0) {
    throw new Error("ENABLED_SOURCES est vide : au moins une source doit être activée");
  }

  return sources as Source[];
}

const enabledSources = parseEnabledSources(process.env.ENABLED_SOURCES);

export const config = {
  // Identifiants eBay uniquement requis si la source eBay est activée : permet de
  // tourner en ENABLED_SOURCES=vinted sans clé eBay (ex: le temps d'une approbation).
  ebayAppId: enabledSources.includes("ebay") ? required("EBAY_APP_ID") : process.env.EBAY_APP_ID ?? "",
  ebayCertId: enabledSources.includes("ebay") ? required("EBAY_CERT_ID") : process.env.EBAY_CERT_ID ?? "",
  discordWebhookUrl: required("DISCORD_WEBHOOK_URL"),
  cronSchedule: process.env.CRON_SCHEDULE ?? "*/10 * * * *",
  dbPath: process.env.DB_PATH ?? "./data/watcher.sqlite",
  watchlistPath: process.env.WATCHLIST_PATH ?? "./watchlist.json",
  // Cookie de session Vinted (JWT), à récupérer manuellement (pas d'API officielle) :
  // connecté sur vinted.fr, DevTools > Application/Storage > Cookies > "access_token_web".
  // Optionnel : sans lui, les requêtes Vinted échouent généralement en 401 (voir vinted.ts).
  // Valeur de démarrage seulement : la valeur réellement utilisée par vinted.ts vit ensuite
  // dans tokenStore.ts (modifiable à chaud via POST /token, voir server.ts), pas ici.
  vintedAccessTokenWeb: process.env.VINTED_ACCESS_TOKEN_WEB || null,
  enabledSources,
  // Port HTTP du serveur d'admin (mise à jour à distance du token Vinted, voir server.ts).
  adminPort: Number(process.env.ADMIN_PORT ?? 3939),
  // Secret partagé requis pour authentifier les requêtes du serveur d'admin. Optionnel :
  // le serveur ne démarre pas du tout si absent, pour ne jamais exposer un endpoint ouvert
  // par accident (voir server.ts / index.ts).
  adminSecret: process.env.ADMIN_SECRET || null,
};

export type Config = typeof config;
