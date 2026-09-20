// Filtre "carte en français" appliqué au TITRE d'une annonce.
//
// Deux modes, car les plateformes n'ont pas le même contexte par défaut :
// - "strict" (eBay, marché international) : un titre sans AUCUN indice de langue est
//   rejeté par défaut -> on préfère rater une bonne affaire FR ambiguë plutôt que
//   spammer Discord avec une carte EN/JP dont le vendeur n'a pas précisé la langue.
// - "assume-french" (Vinted, plateforme déjà francophone par défaut) : un vendeur
//   Vinted n'a aucune raison d'écrire "VF"/"français" sur un site déjà 100% FR -> un
//   titre sans indice est donc accepté par défaut, et seule une mention explicite
//   d'une AUTRE langue (EN/JP/DE/IT/ES...) fait rejeter l'annonce.
export type LanguageFilterMode = "strict" | "assume-french";

// Mots-clés qui indiquent explicitement une langue étrangère -> exclusion immédiate,
// quel que soit le mode.
const FOREIGN_LANGUAGE_PATTERN =
  /\b(english|en anglais|jap(an|on)?ese?|japon(ais)?e?|jp\b|korean|coréen|german|allemand|deutsch|italian|italien(ne)?|italiano|inglese|englisch|karte|carta|condizioni|bellissim[ao]|spedizione|collezione|completo|spanish|espagnol|español|chinese|chinois|dutch|néerlandais|portuguese|portugais)\b/i;

// Abréviations de langue isolées (tags de marketplace, ex: "Charkos EN 🇬🇧").
// "ENG"/"GB"/"UK"/"ITA" n'ont pas d'équivalent courant en français -> vérifiées insensibles
// à la casse. "EN" est en revanche une préposition française extrêmement courante ("carte
// EN parfait état") en minuscules -> on ne la traite comme tag de langue que si elle
// apparaît en MAJUSCULES isolées (comparaison sensible à la casse), ce qui correspond à
// l'usage réel des tags de langue sur les marketplaces.
const FOREIGN_LANGUAGE_ABBREVIATION_PATTERN = /\b(ENG|GB|UK|ITA)\b/i;
const ENGLISH_UPPERCASE_TAG_PATTERN = /\bEN\b/;

// Drapeaux emoji de pays non-francophones -> indicateur fort de langue étrangère.
const FOREIGN_FLAG_EMOJI_PATTERN = /🇬🇧|🇺🇸|🇯🇵|🇩🇪|🇮🇹|🇪🇸/u;

// Mots-clés qui indiquent explicitement une carte française.
const FRENCH_LANGUAGE_PATTERN =
  /\b(vf\b|version fran[çc]aise|carte fran[çc]aise|en fran[çc]ais|fr\b|français(e)?|francaise?)\b/i;

// Codes d'édition FR courants sur les cartes Pokémon (ex: SV151, EV1 FR...) — indice faible, pas suffisant seul.
const FRENCH_HINT_PATTERN = /\b(fr|fra)\b/i;

export interface LanguageCheckResult {
  isFrench: boolean;
  reason: string;
}

export function isFrenchTitle(title: string, mode: LanguageFilterMode = "strict"): LanguageCheckResult {
  const normalized = title.normalize("NFC");

  if (
    FOREIGN_LANGUAGE_PATTERN.test(normalized) ||
    FOREIGN_LANGUAGE_ABBREVIATION_PATTERN.test(normalized) ||
    ENGLISH_UPPERCASE_TAG_PATTERN.test(normalized) ||
    FOREIGN_FLAG_EMOJI_PATTERN.test(normalized)
  ) {
    return { isFrench: false, reason: "mot-clé/abréviation/drapeau langue étrangère détecté" };
  }

  if (FRENCH_LANGUAGE_PATTERN.test(normalized)) {
    return { isFrench: true, reason: "mot-clé langue française détecté" };
  }

  if (FRENCH_HINT_PATTERN.test(normalized)) {
    return { isFrench: true, reason: "indice FR faible détecté (pas de mention étrangère)" };
  }

  if (mode === "assume-french") {
    return {
      isFrench: true,
      reason: "aucune langue étrangère détectée, plateforme francophone par défaut",
    };
  }

  // Aucun indice de langue -> on rejette par défaut (mieux vaut rater que spammer une carte EN).
  return { isFrench: false, reason: "aucun indice de langue française dans le titre" };
}

// Filtre langue appliqué à la DESCRIPTION d'une annonce Vinted (le titre ne mentionne pas
// toujours la langue, mais la description oui : ex. "carte italienne"). Volontairement plus
// prudent que isFrenchTitle : on ne rejette que sur une mention explicite d'une langue
// étrangère (mots-clés, ITA/ENG, drapeaux) ; le tag "EN" en majuscules n'est pas pris en compte
// ici, trop fréquent dans un texte libre. L'absence de mention n'est jamais un motif de rejet.
export function isForeignLanguageDescription(description: string): boolean {
  const normalized = description.normalize("NFC");
  return (
    FOREIGN_LANGUAGE_PATTERN.test(normalized) ||
    FOREIGN_LANGUAGE_ABBREVIATION_PATTERN.test(normalized) ||
    FOREIGN_FLAG_EMOJI_PATTERN.test(normalized)
  );
}

// Entrées watchlist "Reverse stamped" (carte reverse holo à tampon logo, ex: "Dracaufeu 6/108
// (Reverse stamped)") : la carte a le MÊME numéro que sa version holo/normale, donc le numéro ne
// suffit pas à les distinguer -> le titre (ou la description) doit mentionner reverse/stamp/tampon/titre doré (la version recherchée
// a le nom en or et un tampon avec le logo de la série en bas à droite de la zone holo).
const REVERSE_STAMPED_ENTRY_PATTERN = /\breverse\s+stamped\b/i;
const REVERSE_STAMP_MARKER_PATTERN =
  /\b(reverse|revers|stamp(ed)?|tampon(ne|nee)?|titre\s+(en\s+)?(or|dore)|gold\s+title|gold\s+stamp)\b/i;

export function isReverseStampedEntry(entryName: string): boolean {
  return REVERSE_STAMPED_ENTRY_PATTERN.test(entryName);
}

// Mention niée juste avant le mot-clé ("non holo/reverse", "holo (pas reverse)", "sans stamp") :
// ne compte pas comme un marqueur (cas réel : la description dit précisément que la carte n'est
// PAS reverse). Fenêtre courte entre la négation et le mot-clé pour ne pas trop élargir.
const NEGATED_MARKER_PATTERN = /\b(pas|non|sans|no|not)\b[^.\n]{0,15}?\b(reverse|revers|stamp(ed)?|tampon(ne|nee)?)\b/gi;

export function hasReverseStampMarker(text: string): boolean {
  return REVERSE_STAMP_MARKER_PATTERN.test(stripAccents(text).replace(NEGATED_MARKER_PATTERN, " "));
}

// Filtre "produit scellé" : rejette une annonce dont le titre indique explicitement que le
// produit a été ouvert ou est incomplet (ex: un display/ETB/booster vendu ouvert pour en
// sortir les cartes à l'unité), reconditionné/d'occasion (donc pas neuf sous scellé
// d'origine), ou une simple boîte vide (le contenu a déjà été sorti, ex: "ETB vide"). Ne
// s'applique qu'aux entrées watchlist identifiées comme scellées par leur nom
// (Display, ETB, Bundle, Tripack, Booster...) — voir scheduler.ts.
//
// Testé sur le titre avec accents supprimés (voir stripAccents) : \b en JS ne traite pas les
// lettres accentuées comme des caractères de mot, donc "\breconditionné\b" échoue silencieusement
// quand le match se termine juste sur le "é" (rien après, ex: "reconditionné" en fin de titre) —
// la transition "é" (non-mot) -> espace (non-mot) n'est jamais une frontière de mot valide.
const OPENED_PRODUCT_PATTERN = /\b(ouverte?s?|open(ed)?|incomplet(e)?s?|reconditionnee?s?|occasion|vides?)\b/i;

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function isSealed(title: string): boolean {
  return !OPENED_PRODUCT_PATTERN.test(stripAccents(title));
}

// Entrées watchlist représentant un produit scellé (par opposition à une carte à l'unité) :
// identifiables par leur nom. "display" matche aussi "demi-display" (le mot y est présent).
// Utilisé par scheduler.ts (filtre isSealed) et discord.ts (choix de l'emoji/couleur d'embed).
const SEALED_PRODUCT_NAME_PATTERN = /\b(display|etb|bundle|tripack|booster)\b/i;

export function isSealedProductEntry(entryName: string): boolean {
  return SEALED_PRODUCT_NAME_PATTERN.test(entryName);
}

// Entrées watchlist "Collection Classique" du set 30C (reprints à cadre doré, ex: "Pikachu
// 58/102 (CC)") : identifiables par le tag "(CC...)" dans leur nom. Utilisé par scheduler.ts
// (filtre hasThirtyYearMarker) et discord.ts (choix de l'emoji/couleur d'embed).
const CLASSIC_COLLECTION_ENTRY_PATTERN = /\bcc\b/i;

export function isClassicCollectionEntry(entryName: string): boolean {
  return CLASSIC_COLLECTION_ENTRY_PATTERN.test(entryName);
}

// Cas réel diagnostiqué : un reprint Collection Classique GARDE le numéro de la carte d'origine
// ("Nostenfer 47/127" existe à l'identique dans le set Platine de 2009), donc le filtre par
// numéro de carte (voir isRelevantToQuery dans vinted.ts) laisse passer les annonces de la carte
// vintage d'origine -- souvent moins chères, donc elles squattent le top 3 à la place des vrais
// reprints 30 ans. Pour ces entrées, le titre doit donc mentionner explicitement le set 30 ans.
//
// Volontairement STRICT (marqueurs 30 ans uniquement) : "reprint"/"célébrations"/"anniversaire"
// seuls sont ambigus (la Collection Classique de 2021, 25e anniversaire, réimprimait aussi
// Dracaufeu 4/102...). Contrepartie assumée : une annonce d'un vrai reprint 30 ans dont le
// vendeur n'a mis aucun de ces marqueurs dans le titre est écartée -- mieux vaut rater ce cas
// que polluer le classement avec des cartes d'origine. Testé sur le titre sans accents.
//   - "30 ans" / "30ans" / "30e" / "30eme" / "30th" / "30 years"
//   - "30C" (code du set) et "ME5.5" (code de l'extension, vu dans des titres réels)
const THIRTY_YEAR_MARKER_PATTERN = /\b(30\s?(ans|e|eme|th|years?)|30c|thirtieth|me\s?0?5[.,]5)\b/i;

export function hasThirtyYearMarker(title: string): boolean {
  return THIRTY_YEAR_MARKER_PATTERN.test(stripAccents(title));
}
