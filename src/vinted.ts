import { config } from "./config.js";
import { fetchWithRetry } from "./http.js";
import type { MarketplaceItem } from "./types.js";

export type VintedItem = MarketplaceItem;

// Vinted n'a pas d'API publique documentée : on appelle ici l'endpoint interne utilisé
// par leur propre frontend web (catalog/items). Fragile par nature (peut changer sans
// préavis) et potentiellement bloqué (403/429) si le trafic est jugé automatisé -> voir
// isBlockedStatus / le retry dédié plus bas. Nécessite en pratique un cookie de session
// valide (access_token_web), sans quoi l'API répond 401 même avec des en-têtes
// navigateur réalistes -> voir renderRenewalInstructions ci-dessous.
const SEARCH_URL = "https://www.vinted.fr/api/v2/catalog/items";

// En-têtes imitant un navigateur classique. Ça n'annule pas une éventuelle protection
// anti-bot côté Vinted, mais évite les rejets triviaux liés à l'absence de User-Agent / Referer.
const BROWSER_HEADERS = {
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
  { queryPattern: /\bdisplay\b/i, titlePattern: /\bdisplay\b/ },
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
    if (SINGLE_CARD_PREFIX_PATTERN.test(title) || !productType.titlePattern.test(normalizeForMatch(title))) {
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

// retries/delayMsBase/accessTokenWeb exposés (au lieu d'être en dur) pour permettre des
// tests rapides et déterministes sans dépendre de config.ts ni du vrai backoff.
export async function searchVinted(
  query: string,
  limit = 50,
  retries = 3,
  delayMsBase = 1500,
  accessTokenWeb: string | null = config.vintedAccessTokenWeb
): Promise<VintedItem[]> {
  const headers: Record<string, string> = { ...BROWSER_HEADERS };

  if (accessTokenWeb) {
    warnIfAccessTokenLooksExpired(accessTokenWeb);
    headers.Cookie = `access_token_web=${accessTokenWeb}`;
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
  url.searchParams.set("order", "newest_first");
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
      url: item.url ?? `https://www.vinted.fr/items/${item.id}`,
      imageUrl: item.photo?.url ?? null,
    }));
}
