import { config } from "./config.js";
import { runCheck, startScheduler } from "./scheduler.js";
import { startAdminServer } from "./server.js";
import { startAutoTokenRenewal } from "./vintedAuth.js";

console.log("[index] tcg-fr-watcher démarré");
console.log(`[index] cron: ${config.cronSchedule}, sources: ${config.enabledSources.join(", ")}`);

// Démarrés indépendamment du premier cycle : le serveur d'admin (renouvellement à distance du
// token Vinted, voir server.ts) doit être joignable même si ce premier cycle échoue/traîne, et
// le renouvellement automatique (voir vintedAuth.ts) tourne en complément du système manuel,
// sans dépendre du cycle de vérification des annonces.
startAdminServer();
startAutoTokenRenewal();

// Premier passage immédiat au démarrage, puis on laisse le cron prendre le relais.
runCheck()
  .catch((err) => console.error("[index] échec du premier cycle:", err))
  .finally(() => startScheduler());
