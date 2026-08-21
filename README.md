# tcg-fr-watcher

Bot de veille pour les nouvelles annonces de cartes Pokémon **en français** sur eBay et
Vinted, avec alertes envoyées sur Discord via webhook.

Toutes les 10 minutes (configurable), le bot :

1. Recherche chaque carte de la `watchlist.json` sur eBay (Browse API) et Vinted (endpoint interne).
2. Filtre les annonces pour ne garder que celles dont le titre indique une carte **française**
   (exclut explicitement EN/JP/DE/IT/ES).
3. Poste une alerte Discord (image, titre, prix, lien) pour **toute** annonce FR non déjà vue —
   pas de comparaison de prix, pas de notion de "bonne affaire" : c'est un flux brut de nouvelles
   annonces.
4. Marque l'annonce comme vue en base pour ne jamais la reposter.

Chaque source (eBay, Vinted) est interrogée indépendamment par entrée de la watchlist : un
incident sur l'une (clé eBay pas encore approuvée, Vinted qui bloque une requête, etc.) est
loggé et n'empêche pas les autres sources de tourner.

> V2 : eBay + Vinted. Leboncoin (anti-bot Datadome, plus protégé) prévu pour une V3 si Vinted
> seul s'avère insuffisant.

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

### 2. Vinted (cookie de session)

`src/vinted.ts` appelle l'endpoint interne utilisé par le site web (`/api/v2/catalog/items`),
pas une API officielle documentée. En pratique, cet endpoint répond `HTTP 401
invalid_authentication_token` sans cookie de session valide, même avec des en-têtes navigateur
réalistes — il faut donc fournir manuellement le cookie `access_token_web` :

1. Connecte-toi sur [vinted.fr](https://www.vinted.fr/).
2. Ouvre les DevTools du navigateur (F12) > onglet **Application** (Chrome) ou **Stockage** (Firefox)
   > **Cookies** > `https://www.vinted.fr`.
3. Copie la valeur du cookie `access_token_web`.
4. Colle-la dans `.env` :
   ```
   VINTED_ACCESS_TOKEN_WEB=eyJhbGciOi...
   ```

C'est un JWT de courte durée (quelques heures). Le bot **décode sa date d'expiration** et logge
un avertissement clair (`console.warn`) dès qu'il la dépasse, sans attendre une erreur — et si
Vinted répond quand même `401` (session invalidée pour une autre raison), un message tout aussi
clair (`console.error`) explique comment le renouveler. Dans les deux cas, l'entrée concernée est
simplement ignorée pour le cycle en cours (pas de crash). Sans cookie configuré du tout, le bot
continue de tourner mais les requêtes Vinted échoueront très probablement en 401.

### 3. Créer un webhook Discord

1. Dans Discord, sur le salon cible : **Paramètres du salon > Intégrations > Webhooks > Nouveau webhook**.
2. Copier l'URL du webhook.
3. La mettre dans `.env` :
   ```
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```

### 4. Remplir la watchlist

Éditer `watchlist.json` à la racine du projet. Chaque entrée :

```jsonc
{
  "name": "Dracaufeu ex",              // nom affiché dans les logs
  "set": "Écarlate et Violet 151",     // informatif
  "ebayQuery": "Dracaufeu ex 199 carte française",   // requête envoyée à eBay
  "vintedQuery": "Dracaufeu ex 199 carte française"  // requête envoyée à Vinted (optionnel, retombe sur ebayQuery si absent/null)
}
```

## Lancer le bot

```bash
npm run dev     # mode développement, rechargement auto (tsx watch)
npm run build   # compile TypeScript -> dist/
npm run start   # lance la version compilée
npm test        # tests unitaires (node:test)
```

Au démarrage, un premier cycle de vérification tourne immédiatement, puis le cron prend le
relais selon `CRON_SCHEDULE` (par défaut `*/10 * * * *`, toutes les 10 minutes).

## Variables d'environnement

| Variable              | Obligatoire | Défaut                    | Description                                   |
|------------------------|:-----------:|----------------------------|------------------------------------------------|
| `EBAY_APP_ID`           | selon `ENABLED_SOURCES` | — | Client ID eBay Developer (requis seulement si `ebay` est activé) |
| `EBAY_CERT_ID`          | selon `ENABLED_SOURCES` | — | Client Secret eBay Developer (requis seulement si `ebay` est activé) |
| `DISCORD_WEBHOOK_URL`   | oui         | —                           | URL du webhook Discord                          |
| `CRON_SCHEDULE`         | non         | `*/10 * * * *`              | Expression cron du polling                      |
| `DB_PATH`               | non         | `./data/watcher.sqlite`     | Chemin du fichier SQLite                         |
| `WATCHLIST_PATH`        | non         | `./watchlist.json`          | Chemin du fichier watchlist                      |
| `ENABLED_SOURCES`       | non         | `ebay,vinted`               | Sources actives, séparées par des virgules (`ebay`, `vinted`) |
| `VINTED_ACCESS_TOKEN_WEB` | non       | —                           | Cookie de session Vinted (JWT), voir section "Vinted" |

## Architecture

```
src/
  config.ts     # variables d'env typées + validation
  types.ts      # MarketplaceItem : forme commune des annonces (eBay, Vinted, ...)
  ebay.ts       # client eBay Browse API (OAuth2 client credentials)
  vinted.ts     # client Vinted (endpoint interne catalog/items, retry sur 403/429)
  db.ts         # SQLite (node:sqlite) : seen_items (dédup)
  discord.ts    # envoi webhook (embed titre/prix/lien/image)
  matcher.ts    # filtre langue FR (regex titre + exclusions), 2 modes selon la source
  http.ts       # fetch avec retry (backoff linéaire, prédicat de statut retryable configurable)
  scheduler.ts  # orchestration : cron + logique du cycle de vérification (multi-source)
  index.ts      # entrypoint
tests/
  env.ts                  # variables d'env factices, importées en premier par les tests qui touchent config.ts
  matcher.test.ts          # isFrenchTitle() (modes strict + assume-french), fixtures/titles*.json
  discord.test.ts          # sendNewListingAlert() avec fetch mocké, contre tests/fixtures/listing-items.json
  ebay.test.ts              # OAuth + Browse API mockés, contre tests/fixtures/ebay-*.json
  vinted.test.ts             # Browse API Vinted mockée (succès, retry 403/429, retry 5xx), fixtures/vinted-*.json
  fixtures/*.json            # jeux de données des tests
```

`ebay.test.ts` et `vinted.test.ts` ne font aucun appel réseau réel : ils mockent `fetch`
directement. Le token OAuth eBay étant mis en cache au niveau du module `ebay.ts`, les 4 tests
du fichier s'exécutent dans un ordre précis (échec OAuth → succès + mise en cache → réutilisation
du cache → expiration simulée et renouvellement) — voir le commentaire en tête du fichier.
`vinted.test.ts` vérifie en plus : le retry sur 403/429 avec log `console.warn` explicite, la
récupération après une erreur 5xx transitoire, l'envoi du cookie `access_token_web` quand il est
configuré, l'avertissement proactif quand ce cookie est déjà expiré (JWT décodé), et le log clair
quand Vinted répond `401` (session invalide) — le tout via `searchVinted(..., accessTokenWeb)`
qui accepte le token en paramètre explicite pour rester testable sans dépendre de `config.ts`.

Tests écrits avec le test runner intégré à Node (`node:test` + `node:assert`), pas de dépendance
supplémentaire. `npm test` les lance via `tsx --test`.

## Filtre langue (matcher.ts)

`isFrenchTitle(title, mode)` a deux modes, car le "silence" sur la langue ne veut pas dire
la même chose selon la plateforme :

- **`"strict"`** (défaut, utilisé pour eBay) : marché international où un vendeur précise
  généralement la langue explicitement. Un titre sans aucun indice est **rejeté par défaut**
  (mieux vaut rater une annonce FR ambiguë qu'spammer une carte EN/JP).
- **`"assume-french"`** (utilisé pour Vinted) : plateforme déjà 100% francophone par défaut —
  en pratique, un vendeur Vinted n'a aucune raison d'écrire "VF"/"français" sur ses propres
  cartes. Un titre sans indice est donc **accepté par défaut** ; seule une mention explicite
  d'une **autre** langue (EN/JP/DE/IT/ES...) fait rejeter l'annonce.

Dans les deux modes, une mention explicite de langue (française ou étrangère) est traitée
identiquement — seul le comportement par défaut en l'absence d'indice change.

## Limitations connues (V2)

- Le cookie `access_token_web` de Vinted est configuré manuellement et expire au bout de
  quelques heures : sans renouvellement régulier, les requêtes Vinted finissent par échouer
  en 401 (détecté et loggé clairement, voir section "Vinted" ci-dessus, mais pas de renouvellement
  automatique — cela nécessiterait de gérer un `refresh_token_web` et un flux de refresh, hors
  scope volontairement pour rester simple).
- Les `itemId` sont propres à chaque marketplace et ne sont donc pas garantis uniques entre eBay
  et Vinted : `scheduler.ts` préfixe la clé de dédup par source (`ebay:...` / `vinted:...`) dans
  `seen_items` pour éviter toute collision.
- Pas de comparaison de prix ni de notion de "bonne affaire" : le bot poste toute nouvelle
  annonce FR détectée, sans filtre sur le prix. Une watchlist trop large peut donc générer
  beaucoup d'alertes Discord.
- Leboncoin (anti-bot Datadome) n'est pas implémenté — prévu pour une V3 si nécessaire.
