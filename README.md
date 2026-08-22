# tcg-fr-watcher

Bot de veille pour les annonces de cartes/produits Pokémon **en français** sur eBay et
Vinted, avec alertes envoyées sur Discord via webhook.

Toutes les 10 minutes (configurable), le bot, pour chaque entrée de la watchlist et chaque
source activée :

1. Recherche l'entrée sur eBay (Browse API) et/ou Vinted (endpoint interne).
2. Filtre les résultats pour ne garder que ceux dont le titre indique un produit **français**
   (exclut explicitement EN/JP/DE/IT/ES, abréviations isolées EN/ENG/GB/UK et drapeaux
   emoji 🇬🇧🇺🇸🇯🇵🇩🇪🇮🇹🇪🇸), et, pour les entrées de type produit scellé (Display, ETB, Bundle,
   Tripack, Booster), exclut aussi les annonces indiquant un produit ouvert, incomplet,
   reconditionné ou d'occasion, et exige le bon type de produit dans le titre (pas juste un
   chevauchement de mots-clés — une "carte promo ETB" n'est pas un ETB).
3. Recalcule intégralement le **top 3 des moins chères** parmi tous les résultats filtrés du
   cycle (par source — 3 eBay + 3 Vinted, classements indépendants).
4. Compare ce top 3 au dernier état alerté pour cette entrée+source et n'agit que sur ce qui a
   changé : poste une alerte Discord pour chaque annonce qui **entre** dans le top 3, supprime
   le message Discord de chaque annonce qui en **sort**, et laisse inchangé le message de
   chaque annonce qui y **reste** (voir "Top 3 le moins cher + anti-spam" plus bas).

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
  "name": "Méga-Darkrai-ex 116/084 (SIR)", // affiché dans les logs/l'embed Discord ; pilote
                                            // aussi le classement produit scellé (Display,
                                            // ETB, Bundle, Tripack, Booster) et la couleur/
                                            // emoji de rareté (Gold, SIR, AR/UR) — voir
                                            // "Embed Discord" ci-dessous
  "set": "ME05 - Nuit Noire",              // affiché dans le footer de l'embed Discord
  "ebayQuery": "Mega Darkrai ex 116/084 Nuit Noire carte française", // requête envoyée à eBay
  "vintedQuery": "Mega Darkrai ex 116/084 Nuit Noire" // requête envoyée à Vinted (optionnel, retombe sur ebayQuery si absent/null)
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
  db.ts         # SQLite (node:sqlite) : last_alerted_items (top 3 actuel par entrée+source, avec messageId Discord)
  discord.ts    # envoi/suppression webhook (embed stylé : couleur/emoji par rareté, lien cliquable, footer)
  matcher.ts    # filtre langue FR (regex titre + exclusions), 2 modes selon la source
  http.ts       # fetch avec retry (backoff linéaire, prédicat de statut retryable configurable)
  scheduler.ts  # orchestration : cron + logique du cycle de vérification (multi-source)
  index.ts      # entrypoint
tests/
  env.ts                  # variables d'env factices, importées en premier par les tests qui touchent config.ts
  matcher.test.ts          # isFrenchTitle() (strict + assume-french), isSealed(), isSealedProductEntry()
  discord.test.ts          # sendNewListingAlert() avec fetch mocké : embed, rareté, retry 429, throttle
  ebay.test.ts              # OAuth + Browse API mockés, contre tests/fixtures/ebay-*.json
  vinted.test.ts             # Browse API Vinted mockée (succès, retry 403/429, retry 5xx), fixtures/vinted-*.json
  scheduler.test.ts          # selectCheapestN, diffAlertedItems, vintedQueries, dedupeByItemId (fonctions pures)
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
identiquement — seul le comportement par défaut en l'absence d'indice change. `isFrenchTitle`
rejette aussi les abréviations isolées `EN`/`ENG`/`GB`/`UK` et les drapeaux emoji
🇬🇧🇺🇸🇯🇵🇩🇪🇮🇹🇪🇸. `EN` n'est traité comme tag de langue qu'en **majuscules isolées** (sensible à
la casse) : "en" minuscule est une préposition française bien trop courante ("carte **en**
parfait état") pour servir de signal fiable.

## Top 3 le moins cher + anti-spam (scheduler.ts)

Pour chaque entrée de la watchlist et chaque source, `alertCheapestForSource` :

1. Recalcule le top `TOP_N_PER_ENTRY` (3) le moins cher sur **tous** les résultats FR du
   cycle (`selectCheapestN`), pas seulement les nouveaux.
2. Compare ce top 3 (l'ensemble des ids, indépendamment de l'ordre) au dernier état réellement
   alerté pour cette entrée+source, stocké dans `last_alerted_items` (`diffAlertedItems`), et
   n'agit QUE sur ce qui a changé, item par item :
   - un item qui **entre** dans le top 3 est envoyé sur Discord ;
   - un item qui en **sort** (vendu, plus assez cher pour rester dans le top 3...) voit son
     message Discord **supprimé** (`deleteListingAlert`) ;
   - un item qui **reste** dans le top 3 d'un cycle à l'autre n'est ni renvoyé ni supprimé —
     son message existant reste tel quel.
3. Si rien n'est entré ni sorti (même trio qu'au dernier envoi, même réordonné entre eux par
   le prix), rien ne se passe ce cycle-là.

Pour retrouver l'id du message Discord d'un item plus tard (nécessaire pour le supprimer),
`sendNewListingAlert` poste au webhook avec `?wait=true` et retourne l'id renvoyé par Discord ;
`last_alerted_items` stocke donc, par entrée+source, la liste `{itemKey, messageId}` du top 3
actuellement affiché sur Discord (et non plus seulement les ids comme l'ancien
`last_alerted_top3`). Les entrées "produit scellé" (Display, ETB, Bundle, Tripack, Booster —
reconnues par leur `name` dans `watchlist.json`, voir `isSealedProductEntry`) filtrent en plus
les annonces ouvertes/incomplètes/reconditionnées/d'occasion/vides (`isSealed`) et exigent le
bon type de produit dans le titre côté `vinted.ts` (`isRelevantToQuery`), pas juste un
chevauchement de mots-clés.

## Embed Discord (discord.ts)

`sendNewListingAlert(item, entry)` construit un embed stylé à partir du `name` de l'entrée
watchlist, poste au webhook avec `?wait=true` et retourne l'**id du message créé** (nécessaire
pour pouvoir le supprimer plus tard via `deleteListingAlert(messageId)`, voir la section top 3
plus bas) :

- **Couleur** et **emoji** en préfixe du titre selon la rareté détectable dans `name`
  (recherchée dans cet ordre) :
  | Détecté dans `name`         | Couleur       | Emoji |
  |------------------------------|---------------|-------|
  | `Gold`                        | doré          | 🌟    |
  | `SIR`                         | violet        | 🌟    |
  | `AR` / `UR`                   | bleu          | ✨    |
  | produit scellé (`isSealedProductEntry`) | gris | 📦    |
  | rien de tout ça (carte standard) | gris       | (aucun) |
- **Titre** : le titre de l'annonce, débarrassé d'un éventuel `(FR)` redondant en fin de
  chaîne (toutes les annonces sont déjà filtrées FR en amont).
- **Champ `💰 Prix`** : prix en gras.
- **Champ `Annonce`** : lien Markdown cliquable `[🔗 Voir l'annonce](url)` — un footer
  Discord ne peut afficher que du texte brut (jamais de lien cliquable), d'où ce champ dédié
  plutôt qu'un footer du type `item {id}`.
- **Footer** : nom du `set` de l'entrée, combiné au `timestamp` natif de l'embed (Discord
  affiche l'heure d'envoi automatiquement, pas besoin de la formater à la main).

## Limitations connues (V2)

- Le cookie `access_token_web` de Vinted est configuré manuellement et expire au bout de
  quelques heures : sans renouvellement régulier, les requêtes Vinted finissent par échouer
  en 401 (détecté et loggé clairement, voir section "Vinted" ci-dessus, mais pas de renouvellement
  automatique — cela nécessiterait de gérer un `refresh_token_web` et un flux de refresh, hors
  scope volontairement pour rester simple).
- Les `itemId` sont propres à chaque marketplace et ne sont donc pas garantis uniques entre eBay
  et Vinted : `scheduler.ts` préfixe la clé (`ebay:...` / `vinted:...`) pour éviter toute collision
  dans le top 3 stocké.
- Le top 3 n'est comparé que par composition (quels items en font partie), pas par prix ou
  rang exact : si une annonce du top 3 change de prix sans en sortir, aucune alerte n'est
  renvoyée ni son message supprimé (comportement voulu, voir section ci-dessus).
- La suppression d'un message Discord obsolète (`deleteListingAlert`) est du best-effort : si
  elle échoue (Discord indisponible...), l'item n'est simplement plus suivi dans
  `last_alerted_items` — son message reste visible sur Discord sans qu'un nouveau retry de
  suppression soit tenté.
- Leboncoin (anti-bot Datadome) n'est pas implémenté — prévu pour une V3 si nécessaire.
