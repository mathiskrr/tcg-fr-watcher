// Forme commune d'une annonce, quelle que soit la source (eBay, Vinted, ...).
// Permet de traiter les résultats de plusieurs marketplaces de façon interchangeable
// dans scheduler.ts (même filtre langue, même logique de prix, même envoi Discord).
export interface MarketplaceItem {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string | null;
}
