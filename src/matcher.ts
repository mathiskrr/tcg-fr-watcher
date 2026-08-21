// Filtre "carte en français" appliqué au TITRE de l'annonce eBay.
// Approche volontairement simple et sur-inclusive côté exclusion : on préfère
// rater une bonne affaire FR ambiguë plutôt que spammer Discord avec des cartes EN/JP.

// Mots-clés qui indiquent explicitement une langue étrangère -> exclusion immédiate.
const FOREIGN_LANGUAGE_PATTERN =
  /\b(english|en anglais|jap(an|on)?ese?|japon(ais)?e?|jp\b|korean|coréen|german|allemand|deutsch|italian|italien(ne)?|italiano|spanish|espagnol|español|chinese|chinois|dutch|néerlandais|portuguese|portugais)\b/i;

// Mots-clés qui indiquent explicitement une carte française.
const FRENCH_LANGUAGE_PATTERN =
  /\b(vf\b|version fran[çc]aise|carte fran[çc]aise|en fran[çc]ais|fr\b|français(e)?|francaise?)\b/i;

// Codes d'édition FR courants sur les cartes Pokémon (ex: SV151, EV1 FR...) — indice faible, pas suffisant seul.
const FRENCH_HINT_PATTERN = /\b(fr|fra)\b/i;

export interface LanguageCheckResult {
  isFrench: boolean;
  reason: string;
}

export function isFrenchTitle(title: string): LanguageCheckResult {
  const normalized = title.normalize("NFC");

  if (FOREIGN_LANGUAGE_PATTERN.test(normalized)) {
    return { isFrench: false, reason: "mot-clé langue étrangère détecté" };
  }

  if (FRENCH_LANGUAGE_PATTERN.test(normalized)) {
    return { isFrench: true, reason: "mot-clé langue française détecté" };
  }

  if (FRENCH_HINT_PATTERN.test(normalized)) {
    return { isFrench: true, reason: "indice FR faible détecté (pas de mention étrangère)" };
  }

  // Aucun indice de langue -> on rejette par défaut (mieux vaut rater que spammer une carte EN).
  return { isFrench: false, reason: "aucun indice de langue française dans le titre" };
}
