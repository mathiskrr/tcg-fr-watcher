import { config } from "./config.js";
import { fetchWithRetry } from "./http.js";
import { isSealedProductEntry, isClassicCollectionEntry } from "./matcher.js";
import type { MarketplaceItem } from "./types.js";

// Contexte minimal nécessaire à l'embed (nom + set de l'entrée watchlist), sans dépendre du
// type WatchlistEntry de scheduler.ts (qui importe déjà sendNewListingAlert d'ici — éviter
// un import circulaire).
export interface AlertContext {
  name: string;
  set: string;
  // URL exacte de la fiche produit Cardmarket (renseignée à la main dans watchlist.json, une
  // recherche par nom ne peut pas la deviner fiablement -- voir cardmarketSearchUrl). Optionnelle
  // : absente/null -> repli sur une recherche Cardmarket générique par nom.
  cardmarketUrl?: string | null;
}

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

// Couleur + emoji selon la rareté détectable dans le nom de l'entrée watchlist. Vérifiés
// dans cet ordre : Futuriste Rare (nouvelle rareté du set 30C, encore plus rare que SIR — voir
// watchlist.json "Mewtwo-ex 157/128 (Futuriste Rare)", seulement 2 cartes du set l'ont) en
// premier, puis Gold/SIR (haut de gamme), puis Collection Classique (reprints à cadre doré du
// set 30C, ex: "Pikachu 58/102 (CC)" — une catégorie à part, pas une rareté de puissance),
// avant AR/UR, avant le générique "scellé".
const COLOR_FUTURISTIC = 0xff00aa;
const COLOR_GOLD = 0xf1c40f;
const COLOR_PURPLE = 0x9b59b6;
const COLOR_BRONZE = 0xcd7f32;
const COLOR_BLUE = 0x3498db;
const COLOR_GREY = 0x95a5a6;

const FUTURISTIC_PATTERN = /futuriste/i;
const GOLD_PATTERN = /\bgold\b/i;
const SIR_PATTERN = /\bsir\b/i;
const AR_OR_UR_PATTERN = /\b(ar|ur)\b/i;

interface RarityStyle {
  color: number;
  emojiPrefix: string;
}

function detectRarityStyle(entryName: string): RarityStyle {
  if (FUTURISTIC_PATTERN.test(entryName)) {
    return { color: COLOR_FUTURISTIC, emojiPrefix: "🛸 " };
  }
  if (GOLD_PATTERN.test(entryName) || SIR_PATTERN.test(entryName)) {
    return { color: GOLD_PATTERN.test(entryName) ? COLOR_GOLD : COLOR_PURPLE, emojiPrefix: "🌟 " };
  }
  if (isClassicCollectionEntry(entryName)) {
    return { color: COLOR_BRONZE, emojiPrefix: "📜 " };
  }
  if (AR_OR_UR_PATTERN.test(entryName)) {
    return { color: COLOR_BLUE, emojiPrefix: "✨ " };
  }
  if (isSealedProductEntry(entryName)) {
    return { color: COLOR_GREY, emojiPrefix: "📦 " };
  }
  return { color: COLOR_GREY, emojiPrefix: "" };
}

// Toutes les annonces sont déjà filtrées FR en amont (matcher.ts) : le "(FR)" en fin de
// titre, quand un vendeur le met, n'apporte plus rien une fois dans l'embed.
const TRAILING_FR_TAG_PATTERN = /\s*\(fr\)\s*$/i;

function cleanTitle(title: string): string {
  return title.replace(TRAILING_FR_TAG_PATTERN, "").trim();
}

// Retire le suffixe de rareté entre parenthèses en fin de `name` ("(SIR)", "(CC)",
// "(Futuriste Rare)", "(36 boosters)"...) : pas pertinent comme terme de recherche Cardmarket,
// et parfois trompeur (ex: chercher "(CC)" littéralement).
const TRAILING_PAREN_SUFFIX_PATTERN = /\s*\([^)]*\)\s*$/;

// Cas réel diagnostiqué : Cardmarket ne référence PAS ses produits avec le numéro de carte
// dans le champ "Nom" (contrairement aux titres d'annonces Vinted/eBay) -- une recherche
// "Zacian V 138/202" renvoie "Aucun résultat", alors que "Zacian V" seul trouve le produit.
// Retire donc aussi le numéro ("NNN/NNN", zéros de tête inclus) du terme de recherche.
const CARD_NUMBER_PATTERN = /\s*\b\d{1,4}\/\d{1,4}\b\s*/;

// Pas d'API Cardmarket utilisée ici (réservée aux vendeurs professionnels, voir discussion) --
// simple lien de recherche vers leur propre site, que l'utilisateur ouvre lui-même dans son
// navigateur pour comparer manuellement. Gratuit, aucune clé/quota, mais pas de prix récupéré
// automatiquement : juste un raccourci vers une recherche pré-remplie.
function cardmarketSearchUrl(entryName: string): string {
  const query = entryName
    .replace(TRAILING_PAREN_SUFFIX_PATTERN, "")
    .replace(CARD_NUMBER_PATTERN, " ")
    .trim();
  const url = new URL("https://www.cardmarket.com/fr/Pokemon/Products/Search");
  url.searchParams.set("searchString", query);
  return withFranceSellerFilter(url.toString());
}

// ID de pays Cardmarket pour la France (voir documentation officielle de l'API Cardmarket,
// paramètre sellerCountry) -- ne restreint QUE l'affichage par défaut de la page (l'utilisateur
// peut toujours l'élargir à d'autres pays lui-même), mais évite d'avoir à le faire à chaque
// clic : les frais de port et délais depuis la France sont presque toujours les plus
// avantageux pour un acheteur en France.
const CARDMARKET_FRANCE_SELLER_COUNTRY_ID = "12";

function withFranceSellerFilter(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("sellerCountry", CARDMARKET_FRANCE_SELLER_COUNTRY_ID);
  return parsed.toString();
}

function buildEmbed(item: MarketplaceItem, entry: AlertContext) {
  const { color, emojiPrefix } = detectRarityStyle(entry.name);

  return {
    title: `${emojiPrefix}${cleanTitle(item.title)}`,
    url: item.url,
    color,
    thumbnail: item.imageUrl ? { url: item.imageUrl } : undefined,
    fields: [
      { name: "💰 Prix", value: `**${item.price.toFixed(2)} €**`, inline: true },
      // Footer Discord = texte brut (pas de lien cliquable) : le lien vit dans un field à
      // la place, en markdown, pour rester réellement cliquable.
      { name: "Annonce", value: `[🔗 Voir l'annonce](${item.url})`, inline: true },
      // Pas de prix Cardmarket automatique (voir cardmarketSearchUrl) : juste un raccourci pour
      // comparer manuellement en un clic. cardmarketUrl (renseigné à la main dans
      // watchlist.json) pointe directement sur la bonne fiche produit quand disponible ;
      // repli sur une recherche générique par nom sinon (moins précis : peut lister plusieurs
      // variantes/éditions du même nom, voir cas réel diagnostiqué).
      {
        name: "Comparer",
        value: `[🔍 Cardmarket](${
          entry.cardmarketUrl ? withFranceSellerFilter(entry.cardmarketUrl) : cardmarketSearchUrl(entry.name)
        })`,
        inline: true,
      },
    ],
    // `timestamp` (ISO8601) est un champ natif de l'embed Discord : combiné au footer, il
    // affiche "<set> • à l'instant" (ou l'heure exacte) sans avoir à le formater nous-mêmes.
    footer: { text: entry.set },
    timestamp: new Date().toISOString(),
  };
}

// wait=true : sans ce paramètre, Discord répond 204 (aucun corps) et on n'a aucun moyen de
// récupérer l'id du message créé -> impossible de le supprimer plus tard si l'annonce sort
// du top 3 (voir deleteListingAlert / scheduler.ts).
function postEmbed(embed: ReturnType<typeof buildEmbed>): Promise<Response> {
  const url = new URL(config.discordWebhookUrl);
  url.searchParams.set("wait", "true");
  return fetchWithRetry(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

// Le corps d'une réponse 429 Discord contient `retry_after` en secondes (float).
// clone() est nécessaire : on ne veut pas consommer le body si l'appelant doit
// ensuite lire res.text() sur cette même réponse (cas où il n'y a pas de retry).
async function extractRetryAfterMs(res: Response): Promise<number | null> {
  try {
    const body = (await res.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number" && body.retry_after >= 0) {
      return Math.ceil(body.retry_after * 1000);
    }
  } catch {
    // corps non-JSON ou vide -> pas de retry_after exploitable
  }
  return null;
}

// Renvoie l'id du message Discord créé (voir wait=true dans postEmbed), pour permettre de le
// supprimer plus tard si l'annonce sort du top 3 (voir deleteListingAlert).
export async function sendNewListingAlert(
  item: MarketplaceItem,
  entry: AlertContext,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS
): Promise<string> {
  await waitForRateLimit(minIntervalMs);

  const embed = buildEmbed(item, entry);
  let res = await postEmbed(embed);
  let retried = false;

  // Rate-limit Discord (429) : on respecte exactement le retry_after qu'il indique
  // (jamais un délai arbitraire de notre cru), puis on retente une seule fois.
  if (res.status === 429) {
    const retryAfterMs = await extractRetryAfterMs(res);
    if (retryAfterMs !== null) {
      console.warn(
        `[discord] rate limit 429 pour l'item ${item.itemId} — attente de ${retryAfterMs}ms (retry_after indiqué par Discord) avant un unique nouvel essai`
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      res = await postEmbed(embed);
      retried = true;
    } else {
      console.error(`[discord] 429 reçu pour l'item ${item.itemId} sans retry_after exploitable, abandon`);
    }
  }

  if (!res.ok) {
    if (retried && res.status === 429) {
      console.error(`[discord] toujours rate limited (429) après le retry, abandon pour l'item ${item.itemId}`);
    }
    throw new Error(`Envoi webhook Discord échoué: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { id: string };
  return body.id;
}

// Supprime un message précédemment envoyé par CE webhook (une annonce sortie du top 3 des
// moins chères, remplacée par une plus intéressante). 404 = déjà supprimé (message effacé à la
// main, ou salon/webhook recréé entre-temps) -> pas une erreur, on l'ignore silencieusement :
// le but (le message n'est plus visible) est de toute façon déjà atteint.
export async function deleteListingAlert(messageId: string, minIntervalMs = DEFAULT_MIN_INTERVAL_MS): Promise<void> {
  await waitForRateLimit(minIntervalMs);

  const url = new URL(`${config.discordWebhookUrl}/messages/${messageId}`);
  const res = await fetchWithRetry(url.toString(), { method: "DELETE" });

  if (!res.ok && res.status !== 404) {
    throw new Error(`Suppression webhook Discord échouée: ${res.status} ${await res.text()}`);
  }
}
