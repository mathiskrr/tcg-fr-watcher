// Doit être importé (en premier) par tout fichier de test qui charge, même
// transitivement, src/config.ts — sinon `required()` lève au chargement du module.
//
// IMPORTANT: on fixe explicitement TOUTES les variables lues par config.ts, y compris
// celles qui ont une valeur par défaut côté code (VINTED_ACCESS_TOKEN_WEB, ENABLED_SOURCES).
// Sinon, `import "dotenv/config"` dans config.ts charge le vrai fichier .env du projet
// (ex: le cookie Vinted réel du développeur) et les tests deviennent dépendants de son
// contenu / non reproductibles. dotenv ne réécrit jamais une variable déjà présente dans
// process.env, donc fixer une valeur ici (même vide) neutralise le fichier .env réel.
process.env.EBAY_APP_ID ??= "test-app-id";
process.env.EBAY_CERT_ID ??= "test-cert-id";
process.env.DISCORD_WEBHOOK_URL ??= "https://discord.com/api/webhooks/test/test-token";
process.env.PRICE_THRESHOLD ??= "0.7";
process.env.VINTED_ACCESS_TOKEN_WEB ??= "";
process.env.ENABLED_SOURCES ??= "ebay,vinted";
