import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { getVintedAccessToken, setVintedAccessToken } from "./tokenStore.js";
import { decodeJwtExpiry } from "./vinted.js";
import { getLastCycleCompletedAt, getActiveWatchlistCount } from "./scheduler.js";

// Comparaison en temps constant : une comparaison "==="/"==" classique sur des chaînes
// s'arrête au premier caractère différent, ce qui permet en théorie de retrouver le secret
// caractère par caractère en mesurant le temps de réponse (timing attack). timingSafeEqual
// exige des buffers de MÊME longueur (sinon il lève une exception) -> une différence de
// longueur est donc vérifiée à part et rejette directement ; ça ne fuit que la longueur du
// secret, jamais son contenu, donc ça ne compromet pas la comparaison en temps constant.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const BEARER_PATTERN = /^Bearer (.+)$/;

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(BEARER_PATTERN);
  return match ? match[1] : null;
}

// Ne JAMAIS renvoyer/logger le secret ou le token fourni ici : seul le résultat
// (autorisé/refusé) sort de cette fonction.
function isAuthorized(req: IncomingMessage, secret: string): boolean {
  const provided = extractBearerToken(req.headers.authorization);
  if (provided === null) return false;
  return timingSafeEqualStrings(provided, secret);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const MAX_BODY_BYTES = 1024; // largement suffisant pour { "token": "<jwt>" } ; évite un flood mémoire.

// Lève une erreur si le corps dépasse MAX_BODY_BYTES ou n'est pas un JSON valide -> laissé au
// caller (toujours utilisé ici dans un try/catch qui répond 400).
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req as AsyncIterable<Buffer>) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error(`corps de requête trop volumineux (max ${MAX_BODY_BYTES} octets)`);
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.trim() === "" ? {} : JSON.parse(raw);
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

async function handleUpdateToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: `corps de requête invalide: ${(err as Error).message}` });
    return;
  }

  const token = (body as { token?: unknown }).token;
  if (typeof token !== "string" || token.trim() === "") {
    sendJson(res, 400, { error: "champ 'token' manquant ou vide dans le corps JSON" });
    return;
  }

  const trimmedToken = token.trim();
  setVintedAccessToken(trimmedToken);
  const expiresAt = decodeJwtExpiry(trimmedToken);

  // Jamais le token lui-même dans les logs, seule sa date d'expiration décodée (info non
  // sensible : elle ne permet pas de reconstruire le token).
  console.log(
    `[server] token Vinted mis à jour à distance${
      expiresAt !== null ? ` (expire le ${new Date(expiresAt).toISOString()})` : " (expiration non décodable)"
    }`
  );

  sendJson(res, 200, { ok: true, tokenExpiresAt: isoOrNull(expiresAt) });
}

function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
  const token = getVintedAccessToken();
  const expiresAt = token !== null ? decodeJwtExpiry(token) : null;

  sendJson(res, 200, {
    tokenPresent: token !== null,
    tokenExpiresAt: isoOrNull(expiresAt),
    lastCycleCompletedAt: isoOrNull(getLastCycleCompletedAt()),
    watchlistEntryCount: getActiveWatchlistCount(),
  });
}

// Serveur HTTP minimal (pas de framework) pour renouveler le token Vinted à distance (voir
// README "Serveur d'admin"), sans SSH : POST /token pour le mettre à jour, GET /status pour
// vérifier à distance que le bot tourne toujours. `secret` est injecté (plutôt que lu
// directement depuis config.ts ici) pour rester testable sans dépendre de process.env.
export function createAdminServer(secret: string): Server {
  return createServer((req, res) => {
    (async () => {
      if (!isAuthorized(req, secret)) {
        // Log l'IP/route de la tentative, jamais le header Authorization fourni.
        console.warn(
          `[server] tentative d'accès refusée (${req.socket.remoteAddress ?? "IP inconnue"}) sur ${req.method} ${req.url}`
        );
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "POST" && req.url === "/token") {
        await handleUpdateToken(req, res);
        return;
      }

      if (req.method === "GET" && req.url === "/status") {
        handleStatus(req, res);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    })().catch((err) => {
      console.error("[server] erreur inattendue:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });
}

// N'écoute que si ADMIN_SECRET est configuré : pas de démarrage silencieux d'un endpoint
// ouvert (même authentifié) par accident sur un déploiement qui n'en a pas besoin.
export function startAdminServer(): void {
  if (!config.adminSecret) {
    console.log("[server] ADMIN_SECRET non défini — serveur admin désactivé");
    return;
  }

  const server = createAdminServer(config.adminSecret);
  server.listen(config.adminPort, () => {
    console.log(`[server] serveur admin démarré sur le port ${config.adminPort}`);
  });
}
