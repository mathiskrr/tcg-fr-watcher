import { fetchWithRetry } from "./http.js";
import { getVintedAccessToken, getVintedAnonId } from "./tokenStore.js";
import type { MarketplaceItem } from "./types.js";

export type VintedItem = MarketplaceItem;

// Vinted n'a pas d'API publique documentée : on appelle ici l'endpoint interne utilisé
// par leur propre frontend web. Fragile par nature (peut changer sans préavis) et
// potentiellement bloqué (403/429) si le trafic est jugé automatisé -> voir isBlockedStatus /
// le retry dédié plus bas. Nécessite en pratique un cookie de session valide
// (access_token_web) ET l'en-tête X-Anon-Id (voir BROWSER_HEADERS/searchVinted plus bas),
// sans quoi l'API répond respectivement 401/404 -> voir renderRenewalInstructions ci-dessous.
//
// Cas réel diagnostiqué (migration constatée le 2026-09-15, voir historique git) : l'ancien
// chemin "www.vinted.fr/api/v2/catalog/items" renvoie désormais 404 (la page HTML "not found"
// de Vinted, pas un blocage anti-bot) pour TOUTE requête, token valide ou non -- Vinted a migré
// son frontend web vers ce nouveau service. Schéma de réponse JSON inchangé (items[].title/
// price/url/photo), à une exception près : items[].url est maintenant un chemin RELATIF
// ("/items/123-titre") au lieu d'une URL absolue -> voir absoluteItemUrl plus bas.
const SEARCH_URL = "https://api.vinted.fr/svc-catalogue/items";

// En-têtes imitant un navigateur classique. Ça n'annule pas une éventuelle protection
// anti-bot côté Vinted, mais évite les rejets triviaux liés à l'absence de User-Agent / Referer.
// Exporté : réutilisé tel quel par vintedTokenRefresh.ts pour la visite anonyme qui récupère un
// access_token_web frais (même empreinte HTTP, pas de raison de diverger).
export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "fr-FR,fr;q=0.9",
  Referer: "https://www.vinted.fr/catalog",
};

const RENEWAL_INSTRUCTIONS =
  'connecte-toi sur vinted.fr, ouvre les DevTools du navigateur (F12) > Application/Storage > ' +
  'Cookies > https://www.vinted.fr, copie la valeur du cookie "access_token_web", mets à jour ' +
  "VINTED_ACCESS_TOKEN_WEB dans .env, puis redémarre le bot.";

function isBlockedStatus(status: number): boolean {
  return status === 403 || status === 429;
}

// L'API Vinted ne renvoie JAMAIS un résultat vide : une recherche sans aucune annonce
// pertinente (constaté même avec une requête absurde du type "xyzxyzxyz gibberish") fait
// quand même remonter du contenu générique/sans rapport plutôt qu'un tableau vide. C'est
// particulièrement visible sur des requêtes très spécifiques (variantes rares : SAR, AR,
// Gold...) qui n'ont peu ou pas d'annonces actives. search_text filtre donc correctement
// quand des résultats pertinents existent, mais ne garantit rien quand ce n'est pas le cas
// -> on filtre nous-mêmes les résultats a posteriori sur la pertinence du titre.
const STOPWORDS = new Set([
  "fr",
  "française",
  "francaise",
  "vf",
  "carte",
  "cartes",
  "de",
  "des",
  "le",
  "la",
  "du",
  "et",
]);

function normalizeForMatch(text: string): string {
  // NFD + suppression des diacritiques : "Mûre" et "mure" doivent matcher pareil.
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function significantQueryWords(query: string): string[] {
  return normalizeForMatch(query)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

interface CardNumber {
  numerator: number;
  denominator: number;
}

// Numéro de carte Pokémon, format "NNN/084" (numérateur = numéro de la carte dans le set,
// dénominateur = taille du set). Comparaison numérique (pas textuelle) pour ignorer les
// zéros de tête : "4/84" et "004/084" doivent être considérés comme le même numéro.
const CARD_NUMBER_PATTERN = /\b(\d{1,4})\/(\d{1,4})\b/;

function extractCardNumber(text: string): CardNumber | null {
  const match = text.match(CARD_NUMBER_PATTERN);
  if (!match) return null;
  return { numerator: parseInt(match[1], 10), denominator: parseInt(match[2], 10) };
}

function sameCardNumber(a: CardNumber, b: CardNumber): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}

// Type de produit scellé détectable dans une requête (displays, ETB, bundles...). Si la
// requête cible un type précis, le titre DOIT afficher un marqueur du même type -> un simple
// chevauchement de mots-clés ne suffit pas ("Carte promo ETB Nuit Noire ME05" contient "ETB"
// mais n'est pas un ETB ; "Bundle Kit Avant Première ME05 Nuit Noire" partage "ME05 Nuit
// Noire" avec une requête ETB sans être un ETB non plus). "demi-display" est vérifié avant
// "display" : "display" seul matcherait aussi "demi-display" (le mot y est bien présent).
interface ProductTypeMarker {
  queryPattern: RegExp;
  titlePattern: RegExp;
}

// titlePattern est testé sur le titre normalisé (normalizeForMatch : accents/casse
// neutralisés) pour rester robuste aux variantes ("Coffret Dresseur d'Élite" / "coffret
// dresseur elite" / etc.) sans avoir à énumérer toutes les combinaisons d'accents.
const PRODUCT_TYPE_MARKERS: ProductTypeMarker[] = [
  { queryPattern: /\bdemi[\s-]?display\b/i, titlePattern: /\bdemi[\s-]?display\b/ },
  // Lookbehind négatif : une requête "display" (36 boosters) simple ne doit pas matcher un
  // titre "demi-display" (18 boosters) juste parce que "display" y est présent comme
  // sous-chaîne -- sinon une recherche "display Nuit Noire" (sans le mot "demi") remonterait
  // aussi les demi-displays, bien moins chers, et polluerait le classement "moins cher".
  { queryPattern: /\bdisplay\b/i, titlePattern: /(?<!demi[\s-]?)\bdisplay\b/ },
  { queryPattern: /\betb\b/i, titlePattern: /\betb\b|\bcoffret\b[\s\S]*\bdresseur\b|\bdresseur\b[\s\S]*\bcoffret\b/ },
  { queryPattern: /\bbundle\b/i, titlePattern: /\bbundle\b/ },
  { queryPattern: /tri[\s-]?pack/i, titlePattern: /tri[\s-]?pack/ },
  { queryPattern: /\bboosters?\b/i, titlePattern: /\bboosters?\b/ },
];

function findProductTypeMarker(query: string): ProductTypeMarker | null {
  return PRODUCT_TYPE_MARKERS.find((marker) => marker.queryPattern.test(query)) ?? null;
}

// Une annonce de carte à l'unité mentionnant un produit scellé en passant ("Carte promo ETB
// Nuit Noire ME05") contient bien le mot-clé du type de produit -> titlePattern seul ne
// suffit pas à l'écarter. En pratique, sur Vinted, un vendeur qui liste une carte à l'unité
// commence quasi systématiquement le titre par "Carte(s)", alors qu'une annonce de produit
// scellé commence par le nom du produit (Display/ETB/Coffret/Bundle/Tripack/Booster...).
const SINGLE_CARD_PREFIX_PATTERN = /^\s*cartes?\b/i;

// Cas réel remonté en prod : "🔥 Zarude MEP 088 – Promo ETB Nuit Noire – Scellée FR" (5€) --
// une carte promo isolée dont le titre commence par le nom de la carte (pas par "Carte"), donc
// non détectée par SINGLE_CARD_PREFIX_PATTERN, mais qui mentionne bien "ETB"/"Nuit Noire" en
// passant et se glissait dans le top 3 "moins cher" à la place d'un vrai ETB (~65-80€). "promo"
// est un signal fort à lui seul : le contenu d'un vrai coffret scellé (boosters, accessoires)
// n'a aucune raison d'être qualifié de "carte promo" dans son propre titre.
const PROMO_SINGLE_CARD_PATTERN = /\bpromos?\b/i;

// Un titre est jugé pertinent s'il contient au moins la moitié (arrondi au-dessus) des mots
// significatifs de la requête. Évite de rejeter sur un seul mot manquant (accord, abréviation
// différente) tout en filtrant le contenu générique renvoyé par le fallback de Vinted.
//
// Cas particulier : si la requête précise un numéro de carte (ex: "096/084"), un titre qui
// affiche lui aussi un numéro DOIT correspondre exactement -> un simple chevauchement de
// mots-clés ne suffit pas ("Floramantis ex 004/084" ne doit pas matcher une recherche pour
// "Floramantis ex 096/084", même si "Floramantis" et "ex" sont présents dans les deux).
//
// Un titre SANS AUCUN numéro alors que la requête en précise un est REJETÉ, pas laissé
// passer via le filtre mots-clés : pour un Pokémon avec plusieurs versions/raretés dans le
// même set (ex, AR, SIR, gold...), un titre générique du type "Mega Darkrai Ex Nuit Noire"
// ne permet pas de savoir laquelle c'est réellement. En pratique ces titres génériques sont
// souvent bien moins chers (mauvaise carte, valeur différente) et, sans ce rejet, ils
// polluent le classement "moins cher" au détriment des vraies annonces de la bonne variante.
//
// Sinon, si la requête cible un type de produit scellé (display, ETB, bundle...), le titre
// doit afficher le marqueur de ce type précis -> voir PRODUCT_TYPE_MARKERS ci-dessus.
//
// Le filtre mots-clés seul ne s'applique donc que pour le reste (aucun numéro, aucun type de
// produit détecté dans la requête).
export function isRelevantToQuery(title: string, query: string): boolean {
  const queryCardNumber = extractCardNumber(query);
  if (queryCardNumber !== null) {
    const titleCardNumber = extractCardNumber(title);
    if (titleCardNumber === null) return false;
    return sameCardNumber(queryCardNumber, titleCardNumber);
  }

  const productType = findProductTypeMarker(query);
  if (productType !== null) {
    if (
      SINGLE_CARD_PREFIX_PATTERN.test(title) ||
      PROMO_SINGLE_CARD_PATTERN.test(title) ||
      !productType.titlePattern.test(normalizeForMatch(title))
    ) {
      return false;
    }
  }

  const words = significantQueryWords(query);
  if (words.length === 0) return true;

  const normalizedTitle = normalizeForMatch(title);
  const matches = words.filter((word) => normalizedTitle.includes(word));
  const requiredMatches = Math.max(1, Math.ceil(words.length / 2));

  return matches.length >= requiredMatches;
}

// access_token_web est un JWT. On décode juste son payload (aucune vérif de signature :
// on ne fait pas confiance au contenu, on veut seulement lire la date d'expiration pour
// prévenir avant même d'envoyer la requête). Retourne null si le format est inattendu.
export function decodeJwtExpiry(token: string): number | null {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const json = Buffer.from(payloadPart, "base64url").toString("utf-8");
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function warnIfAccessTokenLooksExpired(token: string): void {
  const expiresAt = decodeJwtExpiry(token);
  if (expiresAt !== null && Date.now() >= expiresAt) {
    console.warn(
      `[vinted] le cookie access_token_web semble expiré (expiration détectée: ${new Date(
        expiresAt
      ).toISOString()}) — ${RENEWAL_INSTRUCTIONS}`
    );
  }
}

interface VintedApiResponse {
  items?: Array<{
    id: number;
    title: string;
    price?: { amount: string; currency_code: string };
    url?: string;
    photo?: { url: string } | null;
  }>;
}

// Vu depuis la migration (voir commentaire sur SEARCH_URL) : sans X-Anon-Id, l'API répond 404
// -- ni 401 ni 403, donc indiscernable d'un endpoint qui n'existe plus sans ce message explicite.
const MISSING_ANON_ID_WARNING =
  "[vinted] aucun X-Anon-Id disponible (renouvellement anonyme du token pas encore passé, voir vintedTokenRefresh.ts) -- la requête va probablement échouer en 404";

// retries/delayMsBase/accessTokenWeb/anonId exposés (au lieu d'être en dur) pour permettre des
// tests rapides et déterministes sans dépendre de tokenStore.ts ni du vrai backoff.
// accessTokenWeb/anonId retombent sur tokenStore.ts (pas directement config.ts) : tous deux
// peuvent être renouvelés à chaud (voir server.ts / vintedTokenRefresh.ts) sans redémarrer le
// process.
export async function searchVinted(
  query: string,
  limit = 96,
  retries = 3,
  delayMsBase = 1500,
  accessTokenWeb: string | null = getVintedAccessToken(),
  anonId: string | null = getVintedAnonId()
): Promise<VintedItem[]> {
  const headers: Record<string, string> = { ...BROWSER_HEADERS };

  if (accessTokenWeb) {
    warnIfAccessTokenLooksExpired(accessTokenWeb);
    headers.Cookie = `access_token_web=${accessTokenWeb}`;
  }

  if (anonId) {
    headers["X-Anon-Id"] = anonId;
  } else {
    console.warn(MISSING_ANON_ID_WARNING);
  }

  // IMPORTANT: pas de catalog_ids ici. Un id de catégorie "Cartes à collectionner" a été
  // deviné (3025) puis vérifié empiriquement contre l'API réelle : dès qu'un catalog_ids
  // est présent, Vinted ignore silencieusement search_text et renvoie les annonces les
  // plus récentes de cette catégorie (souvent hors-sujet : consoles, figurines...) au lieu
  // d'une erreur ou d'un résultat vide. search_text seul, lui, filtre correctement (vérifié
  // sur des requêtes réelles : "iphone", "carte pokemon", "display Nuit Noire ME05 36
  // boosters" retournent toutes des résultats pertinents sans catalog_ids).
  const url = new URL(SEARCH_URL);
  url.searchParams.set("search_text", query);
  // Pas de order=newest_first : sur une carte populaire (des centaines d'annonces), les 96
  // plus récentes ne couvrent que quelques jours et ratent des annonces pourtant actives
  // (constaté : des annonces vieilles de quelques semaines n'apparaissaient jamais). Le tri par
  // pertinence par défaut de Vinted les remonte ; 96 = per_page maximal accepté.
  url.searchParams.set("per_page", String(limit));

  const res = await fetchWithRetry(
    url.toString(),
    { headers },
    retries,
    delayMsBase,
    (status) => status >= 500 || isBlockedStatus(status)
  );

  if (!res.ok) {
    if (res.status === 401) {
      console.error(`[vinted] session invalide ou expirée (HTTP 401) — ${RENEWAL_INSTRUCTIONS}`);
    } else if (isBlockedStatus(res.status)) {
      console.warn(
        `[vinted] blocage anti-bot probable (HTTP ${res.status}) après ${retries} tentative(s), requête ignorée pour ce cycle`
      );
    }
    throw new Error(`Vinted API a échoué: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as VintedApiResponse;

  return (data.items ?? [])
    .filter((item) => item.price && isRelevantToQuery(item.title, query))
    .map((item) => ({
      itemId: String(item.id),
      title: item.title,
      price: Number(item.price!.amount),
      currency: item.price!.currency_code,
      url: absoluteItemUrl(item.url, item.id),
      imageUrl: item.photo?.url ?? null,
    }));
}

// Depuis la migration vers svc-catalogue (voir commentaire sur SEARCH_URL), items[].url est un
// chemin relatif ("/items/123-titre") au lieu d'une URL absolue -> le lien posté sur Discord
// serait autrement cassé (relatif à rien). Le préfixe n'est ajouté que si besoin : reste
// compatible si Vinted redevient un jour absolu, ou si un fallback (absent d'items[].url)
// fournit déjà une URL absolue.
function absoluteItemUrl(url: string | undefined, itemId: number): string {
  if (!url) return `https://www.vinted.fr/items/${itemId}`;
  return url.startsWith("/") ? `https://www.vinted.fr${url}` : url;
}

// Le endpoint de recherche ne renvoie pas la description : on la lit dans le HTML de la page de
// l'annonce, qui l'embarque en JSON ("description":"..."). Retourne null si absente/illisible
// (format de page changé, annonce supprimée...) : l'appelant traite alors l'annonce comme
// "pas de mention détectée" plutôt que de la rejeter.
export function extractItemDescription(html: string): string | null {
  const match = html.match(/"description":("(?:[^"\\]|\\.)*")/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function fetchVintedDescription(
  itemUrl: string,
  accessTokenWeb: string | null = getVintedAccessToken(),
  anonId: string | null = getVintedAnonId()
): Promise<string | null> {
  const headers: Record<string, string> = { ...BROWSER_HEADERS, Accept: "text/html" };
  if (accessTokenWeb) headers.Cookie = `access_token_web=${accessTokenWeb}`;
  if (anonId) headers["X-Anon-Id"] = anonId;

  // 403/429 retentés aussi (blocage anti-bot temporaire quand plusieurs pages sont lues d'affilée).
  const res = await fetchWithRetry(itemUrl, { headers }, 3, 1500, (status) => status >= 500 || isBlockedStatus(status));
  if (!res.ok) throw new Error(`Vinted page annonce a échoué: ${res.status}`);
  return extractItemDescription(await res.text());
}
