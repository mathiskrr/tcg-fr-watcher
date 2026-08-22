import { config } from "./config.js";
import { runCheck, startScheduler } from "./scheduler.js";
import { startAdminServer } from "./server.js";

console.log("[index] tcg-fr-watcher démarré");
console.log(`[index] cron: ${config.cronSchedule}, sources: ${config.enabledSources.join(", ")}`);

// Démarré indépendamment du premier cycle : le serveur d'admin (renouvellement à distance du
// token Vinted, voir server.ts) doit être joignable même si ce premier cycle échoue/traîne.
startAdminServer();

// Premier passage immédiat au démarrage, puis on laisse le cron prendre le relais.
runCheck()
  .catch((err) => console.error("[index] échec du premier cycle:", err))
  .finally(() => startScheduler());
