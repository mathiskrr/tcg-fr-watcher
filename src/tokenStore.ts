import { config } from "./config.js";

// Le cookie de session Vinted expire toutes les ~2h et doit pouvoir être renouvelé sans
// redémarrer le process (contrairement à .env/process.env, relus seulement au démarrage) :
// server.ts (POST /token) met à jour cette valeur en mémoire, et vinted.ts la lit à chaque
// recherche. Initialisée depuis config.ts pour rester compatible avec un simple redémarrage
// (token fourni via .env) quand le serveur d'admin n'est pas utilisé.
let vintedAccessToken: string | null = config.vintedAccessTokenWeb;

export function getVintedAccessToken(): string | null {
  return vintedAccessToken;
}

export function setVintedAccessToken(token: string): void {
  vintedAccessToken = token;
}
