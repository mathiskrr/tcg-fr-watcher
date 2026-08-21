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
  /\b(english|en anglais|jap(an|on)?ese?|japon(ais)?e?|jp\b|korean|coréen|german|allemand|deutsch|italian|italien(ne)?|italiano|spanish|espagnol|español|chinese|chinois|dutch|néerlandais|portuguese|portugais)\b/i;

// Abréviations de langue isolées (tags de marketplace, ex: "Charkos EN 🇬🇧").
// "ENG"/"GB"/"UK" n'ont pas d'équivalent courant en français -> vérifiées insensibles à
// la casse. "EN" est en revanche une préposition française extrêmement courante ("carte
// EN parfait état") en minuscules -> on ne la traite comme tag de langue que si elle
// apparaît en MAJUSCULES isolées (comparaison sensible à la casse), ce qui correspond à
// l'usage réel des tags de langue sur les marketplaces.
const FOREIGN_LANGUAGE_ABBREVIATION_PATTERN = /\b(ENG|GB|UK)\b/i;
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

// Filtre "produit scellé" : rejette une annonce dont le titre indique explicitement que le
// produit a été ouvert ou est incomplet (ex: un display/ETB/booster vendu ouvert pour en
// sortir les cartes à l'unité), ou reconditionné/d'occasion (donc pas neuf sous scellé
// d'origine). Ne s'applique qu'aux entrées watchlist identifiées comme scellées par leur nom
// (Display, ETB, Bundle, Tripack, Booster...) — voir scheduler.ts.
//
// Testé sur le titre avec accents supprimés (voir stripAccents) : \b en JS ne traite pas les
// lettres accentuées comme des caractères de mot, donc "\breconditionné\b" échoue silencieusement
// quand le match se termine juste sur le "é" (rien après, ex: "reconditionné" en fin de titre) —
// la transition "é" (non-mot) -> espace (non-mot) n'est jamais une frontière de mot valide.
const OPENED_PRODUCT_PATTERN = /\b(ouverte?s?|open(ed)?|incomplet(e)?s?|reconditionnee?s?|occasion)\b/i;

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function isSealed(title: string): boolean {
  return !OPENED_PRODUCT_PATTERN.test(stripAccents(title));
}
