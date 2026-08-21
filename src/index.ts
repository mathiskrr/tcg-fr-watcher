import { config } from "./config.js";
import { runCheck, startScheduler } from "./scheduler.js";

console.log("[index] tcg-fr-watcher démarré");
console.log(
  `[index] seuil bonne affaire: ${config.priceThreshold}, cron: ${config.cronSchedule}, sources: ${config.enabledSources.join(", ")}`
);

// Premier passage immédiat au démarrage, puis on laisse le cron prendre le relais.
runCheck()
  .catch((err) => console.error("[index] échec du premier cycle:", err))
  .finally(() => startScheduler());
