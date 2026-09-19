// Renouvellement du token Vinted par simple visite anonyme (aucun identifiant, aucun
// navigateur) -- remplace l'ancien renouvellement par login Playwright (voir historique git),
// retiré car inutile : Vinted délivre un access_token_web valide à toute visite anonyme, sans
// compte, comme confirmé empiriquement (voir README "Limitations connues"). Un simple GET vers
// une page publique produit le même cookie qu'un vrai login, sans se battre contre le widget
// Cloudflare Turnstile qui protège la page de login elle-même (jamais nécessaire ici).
//
// N'élimine pas complètement le risque de blocage anti-bot (Cloudflare/DataDome peuvent aussi
// bloquer cette requête depuis certaines IP), mais reste un profil de trafic bien plus discret
// qu'un login automatisé répété : une simple page visitée périodiquement, sans identifiants à
// exposer ni navigateur à faire tourner.

import { fetchWithRetry } from "./http.js";
import { BROWSER_HEADERS, decodeJwtExpiry } from "./vinted.js";
import { setVintedAccessToken } from "./tokenStore.js";

// Page publique minimale : peu importe laquelle, Vinted pose le cookie sur toute réponse de son
// domaine principal dès qu'aucune session valide n'est déjà présente côté serveur.
const ANON_TOKEN_PAGE_URL = "https://www.vinted.fr/";

const ACCESS_TOKEN_COOKIE_NAME = "access_token_web";

// Extrait la valeur d'un cookie nommé depuis les en-têtes Set-Cookie bruts d'une réponse
// (`response.headers.getSetCookie()`, chaque entrée de la forme "nom=valeur; Attr1; Attr2...").
// Vinted renvoie parfois le même cookie deux fois dans une seule réponse (une valeur vide qui
// l'expire explicitement, en plus de la vraie valeur -- constaté empiriquement, ordre non
// garanti) : une valeur vide ne remplace donc JAMAIS une valeur déjà trouvée, quel que soit
// l'ordre des en-têtes -- seule la dernière valeur NON VIDE l'emporte.
export function extractCookieValue(setCookieHeaders: string[], cookieName: string): string | null {
  let value: string | null = null;

  for (const header of setCookieHeaders) {
    const firstPair = header.split(";")[0];
    const eqIndex = firstPair.indexOf("=");
    if (eqIndex === -1) continue;

    const name = firstPair.slice(0, eqIndex).trim();
    if (name !== cookieName) continue;

    const candidate = firstPair.slice(eqIndex + 1).trim();
    if (candidate.length > 0) {
      value = candidate;
    }
  }

  return value;
}

// retries/delayMsBase exposés (au lieu d'être en dur) pour les mêmes raisons que searchVinted
// dans vinted.ts -- tests rapides et déterministes sans dépendre du vrai backoff.
export async function fetchAnonymousVintedToken(retries = 3, delayMsBase = 1500): Promise<string | null> {
  const res = await fetchWithRetry(ANON_TOKEN_PAGE_URL, { headers: BROWSER_HEADERS }, retries, delayMsBase);

  const setCookieHeaders = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return extractCookieValue(setCookieHeaders, ACCESS_TOKEN_COOKIE_NAME);
}

// retries/delayMsBase exposés (au lieu d'être en dur), même raison que fetchAnonymousVintedToken
// ci-dessus : permet aux tests du chemin d'erreur réseau de rester rapides sans attendre le
// vrai backoff (voir tests/vintedTokenRefresh.test.ts).
export async function renewVintedTokenAnonymously(retries = 3, delayMsBase = 1500): Promise<void> {
  console.log("[vintedTokenRefresh] tentative de renouvellement anonyme du token Vinted...");

  try {
    const token = await fetchAnonymousVintedToken(retries, delayMsBase);
    if (!token) {
      console.warn(
        "[vintedTokenRefresh] aucun cookie access_token_web reçu (page Vinted peut-être bloquée) -- renouvellement manuel toujours disponible en secours (voir README)"
      );
      return;
    }

    setVintedAccessToken(token);
    const expiresAt = decodeJwtExpiry(token);
    console.log(
      `[vintedTokenRefresh] token Vinted renouvelé anonymement${
        expiresAt !== null ? ` (expire le ${new Date(expiresAt).toISOString()})` : " (expiration non décodable)"
      }`
    );
  } catch (err) {
    console.error("[vintedTokenRefresh] échec du renouvellement anonyme:", err);
  }
}

// Le token anonyme dure ~24h (constaté empiriquement sur un exemple réel) -- 12h laisse une
// marge confortable sans multiplier les requêtes pour rien.
const RENEWAL_INTERVAL_MS = 12 * 60 * 60 * 1000;

let renewalTimer: NodeJS.Timeout | null = null;

// `renew` injectable (au lieu d'appeler directement renewVintedTokenAnonymously) pour rester
// testable sans requête réseau réelle -- même principe que l'ancien startAutoTokenRenewal
// (vintedAuth.ts, retiré).
export function startAnonymousTokenRenewal(
  intervalMs = RENEWAL_INTERVAL_MS,
  renew: () => Promise<void> = renewVintedTokenAnonymously
): void {
  // Appel immédiat au démarrage, EN PLUS du cycle périodique ci-dessous : valide tout de suite
  // qu'un token est bien obtenu (déploiement, changement réseau...) sans attendre 12h.
  renew().catch((err) => console.error("[vintedTokenRefresh] erreur au renouvellement immédiat du démarrage:", err));

  renewalTimer = setInterval(() => {
    renew().catch((err) => console.error("[vintedTokenRefresh] erreur cycle de renouvellement anonyme:", err));
  }, intervalMs);

  console.log(
    `[vintedTokenRefresh] renouvellement anonyme du token Vinted armé (immédiat + toutes les ${Math.round(intervalMs / 3_600_000)}h)`
  );
}

export function stopAnonymousTokenRenewal(): void {
  if (renewalTimer !== null) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }
}
