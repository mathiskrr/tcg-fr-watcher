# tcg-fr-watcher

Bot de veille "bonnes affaires" pour les cartes Pokémon **en français** sur eBay,
avec alertes envoyées sur Discord via webhook.

Toutes les 10 minutes (configurable), le bot :

1. Recherche chaque carte de la `watchlist.json` sur eBay (Browse API, marketplace FR).
2. Filtre les annonces pour ne garder que celles dont le titre indique une carte **française**
   (exclut explicitement EN/JP/DE/IT/ES).
3. Compare le prix de l'annonce à un prix de référence (Cardmarket, ou prix fixé à la main).
4. Si l'annonce est au moins `(1 - PRICE_THRESHOLD) * 100`% moins chère que la référence,
   poste une alerte Discord (image, titre, prix, lien, écart %).
5. Marque l'annonce comme vue en base pour ne jamais la reposter.

> V1 : eBay uniquement. Vinted et Leboncoin sont prévus pour une V2.

## Stack

- Node.js (>= 22.5) + TypeScript, ESM
- SQLite via le module intégré [`node:sqlite`](https://nodejs.org/api/sqlite.html) (pas de dépendance native à compiler)
- `node-cron` pour le polling périodique
- `dotenv` pour la config
- Pas de bot Discord "gateway" : uniquement un webhook sortant.

## Installation

```bash
npm install
cp .env.example .env
```

### 1. Obtenir des clés eBay Developer

1. Créer un compte sur [developer.ebay.com](https://developer.ebay.com/) et se connecter.
2. Aller dans **My Account > Application Keys**.
3. Créer une "keyset" en environnement **Production** (le Sandbox ne contient pas de vraies annonces).
4. Récupérer le **Client ID** (`App ID`) et le **Client Secret** (`Cert ID`).
5. Les mettre dans `.env` :
   ```
   EBAY_APP_ID=...
   EBAY_CERT_ID=...
   ```

Le bot utilise le flux OAuth2 *Client Credentials* (application, sans utilisateur eBay) pour
appeler la [Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html) — voir
`src/ebay.ts`.

### 2. Créer un webhook Discord

1. Dans Discord, sur le salon cible : **Paramètres du salon > Intégrations > Webhooks > Nouveau webhook**.
2. Copier l'URL du webhook.
3. La mettre dans `.env` :
   ```
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```

### 3. Remplir la watchlist

Éditer `watchlist.json` à la racine du projet. Chaque entrée :

```jsonc
{
  "name": "Dracaufeu ex",              // nom affiché dans les logs
  "set": "Écarlate et Violet 151",     // informatif
  "ebayQuery": "Dracaufeu ex 199 carte française", // requête envoyée à eBay
  "cardmarketUrl": "https://www.cardmarket.com/fr/Pokemon/Products/Singles/...",
  "referencePrice": null               // si non-null, utilisé à la place du scraping Cardmarket
}
```

- Si `referencePrice` est renseigné, il est utilisé tel quel (aucun appel réseau vers Cardmarket).
- Sinon, le bot scrape la page produit Cardmarket (`cardmarketUrl`) pour en extraire le prix
  moyen, avec un cache de 24h en base (`price_cache`). **Ce scraping est fragile** : il dépend du
  markup HTML actuel de Cardmarket (voir `src/cardmarket.ts`) et Cardmarket peut bloquer les
  requêtes automatisées (HTTP 403). Si ça arrive, l'entrée est simplement ignorée le temps du
  cycle (log `[cardmarket] échec fetch ...`) — renseigner `referencePrice` à la main reste la
  solution la plus fiable en attendant une vraie intégration API Cardmarket (nécessite un
  partenariat marchand).

## Lancer le bot

```bash
npm run dev     # mode développement, rechargement auto (tsx watch)
npm run build   # compile TypeScript -> dist/
npm run start   # lance la version compilée
npm test        # tests unitaires (node:test) sur matcher.ts et discord.ts
```

Au démarrage, un premier cycle de vérification tourne immédiatement, puis le cron prend le
relais selon `CRON_SCHEDULE` (par défaut `*/10 * * * *`, toutes les 10 minutes).

## Variables d'environnement

| Variable              | Obligatoire | Défaut                    | Description                                   |
|------------------------|:-----------:|----------------------------|------------------------------------------------|
| `EBAY_APP_ID`           | oui         | —                           | Client ID eBay Developer                        |
| `EBAY_CERT_ID`          | oui         | —                           | Client Secret eBay Developer                    |
| `DISCORD_WEBHOOK_URL`   | oui         | —                           | URL du webhook Discord                          |
| `PRICE_THRESHOLD`       | non         | `0.7`                       | Seuil "bonne affaire" : prix ≤ référence × seuil |
| `CRON_SCHEDULE`         | non         | `*/10 * * * *`              | Expression cron du polling                      |
| `DB_PATH`               | non         | `./data/watcher.sqlite`     | Chemin du fichier SQLite                         |
| `WATCHLIST_PATH`        | non         | `./watchlist.json`          | Chemin du fichier watchlist                      |

## Architecture

```
src/
  config.ts     # variables d'env typées + validation
  ebay.ts       # client eBay Browse API (OAuth2 client credentials)
  cardmarket.ts # prix de référence (scraping léger + cache SQLite)
  pricing.ts    # logique "bonne affaire" (seuil % configurable)
  db.ts         # SQLite (node:sqlite) : seen_items (dédup), price_cache
  discord.ts    # envoi webhook (embed)
  matcher.ts    # filtre langue FR (regex titre + exclusions)
  http.ts       # fetch avec retry (backoff linéaire, 3 tentatives)
  scheduler.ts  # orchestration : cron + logique du cycle de vérification
  index.ts      # entrypoint
tests/
  env.ts               # variables d'env factices, importées en premier par les tests qui touchent config.ts
  matcher.test.ts       # isFrenchTitle() contre tests/fixtures/titles.json
  discord.test.ts       # sendDealAlert() avec fetch mocké, contre tests/fixtures/deal-items.json
  ebay.test.ts           # OAuth + Browse API mockés, contre tests/fixtures/ebay-*.json
  fixtures/*.json        # jeux de données des tests
```

`ebay.test.ts` ne fait aucun appel réseau réel : il mocke `fetch` pour simuler le flux
OAuth2 *client credentials* et une réponse Browse API. Le token étant mis en cache au
niveau du module `ebay.ts`, les 3 tests du fichier s'exécutent dans un ordre précis
(échec OAuth → succès + mise en cache → réutilisation du cache) — voir le commentaire
en tête du fichier.

Tests écrits avec le test runner intégré à Node (`node:test` + `node:assert`), pas de dépendance
supplémentaire. `npm test` les lance via `tsx --test`.

## Limitations connues (V1)

- Une seule source (eBay). Vinted / Leboncoin prévus en V2.
- Le filtre langue est basé sur des regex sur le titre : une annonce sans aucun indice de langue
  est **rejetée par défaut** (mieux vaut rater une affaire qu'spammer une carte non-FR).
- Le prix de référence Cardmarket est obtenu par scraping léger, pas via l'API officielle
  (accès restreint aux marchands partenaires) — privilégier `referencePrice` fixe si le scraping
  est bloqué.
