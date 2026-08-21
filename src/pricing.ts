export interface DealEvaluation {
  isGoodDeal: boolean;
  discountPercent: number; // ex: 32 pour -32% vs référence
}

// Une annonce est une "bonne affaire" si son prix est <= referencePrice * threshold.
// threshold = 0.7 => l'annonce doit être au moins 30% moins chère que le marché.
export function evaluateDeal(
  listingPrice: number,
  referencePrice: number,
  threshold: number
): DealEvaluation {
  if (referencePrice <= 0) {
    return { isGoodDeal: false, discountPercent: 0 };
  }

  const discountPercent = Math.round((1 - listingPrice / referencePrice) * 100);
  const isGoodDeal = listingPrice <= referencePrice * threshold;

  return { isGoodDeal, discountPercent };
}
