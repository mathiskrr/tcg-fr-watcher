// Doit être importé (en premier) par tout fichier de test qui charge, même
// transitivement, src/config.ts — sinon `required()` lève au chargement du module.
process.env.EBAY_APP_ID ??= "test-app-id";
process.env.EBAY_CERT_ID ??= "test-cert-id";
process.env.DISCORD_WEBHOOK_URL ??= "https://discord.com/api/webhooks/test/test-token";
process.env.PRICE_THRESHOLD ??= "0.7";
