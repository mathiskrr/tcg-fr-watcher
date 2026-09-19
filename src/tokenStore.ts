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

// Cas réel diagnostiqué (2026-09) : depuis la migration de Vinted vers son nouvel endpoint de
// recherche (svc-catalogue, voir vinted.ts), une requête sans en-tête X-Anon-Id échoue -- sa
// valeur est fournie par Vinted lui-même dans l'en-tête de réponse "x-anon-id" de toute visite
// anonyme (voir vintedTokenRefresh.ts, qui la récupère en même temps que access_token_web). Pas
// de valeur par défaut/`config` ici : contrairement au token, il n'y a pas de fallback manuel
// via .env pour celui-ci (pas d'équivalent "cookie copié depuis DevTools" aussi pratique), donc
// null tant que le renouvellement anonyme n'a pas tourné au moins une fois.
let vintedAnonId: string | null = null;

export function getVintedAnonId(): string | null {
  return vintedAnonId;
}

export function setVintedAnonId(anonId: string): void {
  vintedAnonId = anonId;
}
