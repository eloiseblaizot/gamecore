/**
 * Serveur du jeu d'exemple : fichiers de l'application + serveur de jeu Socket.io.
 *
 * Variables d'environnement :
 *   PORT             port d'écoute (3001 par défaut)
 *   ALLOWED_ORIGINS  origines autorisées à ouvrir une connexion, séparées par des virgules
 *                    (par défaut : http://localhost:PORT et le serveur de dev Vite)
 *   TRUST_PROXY      « 1 » derrière un proxy de confiance (lecture de X-Forwarded-For)
 *   ROOMS_PER_MINUTE_PER_IP, FAILED_JOINS_PER_MINUTE
 *                    limites par adresse IP (10 et 12 par défaut). Attention : derrière une
 *                    même box, tous les téléphones d'une soirée partagent la même adresse.
 *   NODE_ENV         « production » pour servir dist/ (sinon Vite sert l'application)
 *
 * Discord (facultatif, voir docs/discord.md) :
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET   application Discord (le secret reste ici)
 *   DISCORD_REDIRECT_URI   URL de retour de la connexion web (ex. https://monjeu.fr/auth/discord)
 *   DISCORD_ACTIVITY       « 1 » pour autoriser l'affichage dans Discord (Activity)
 *   DISCORD_API_BASE, DISCORD_AUTHORIZE_URL   uniquement pour les tests (faux Discord)
 */

import { createDiscordTokenHandler, discordAuthenticator, toNodeHandler } from "@gamecore/discord/server";
import { DISCORD_PROVIDER } from "@gamecore/discord";
import { GameServer, consoleLogger, controllerModule } from "@gamecore/server";
import { attachSocketIo, secureSocketIoOptions } from "@gamecore/server/socket-io";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { buzzer } from "../src/game.js";
import { reactionSchema } from "../src/reactions.js";
import { DISCORD_FRAME_ANCESTORS, staticHandler } from "./http.js";

const env = process.env;
const port = Number(env.PORT ?? 3001);
const production = env.NODE_ENV === "production";
const trustProxy = env.TRUST_PROXY === "1";
const allowedOrigins = (env.ALLOWED_ORIGINS ?? `http://localhost:${port},http://localhost:5173`)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/** Lit un entier positif dans l'environnement, avec une valeur par défaut. */
const envInt = (name: string, fallback: number) => {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** Discord n'est activé que si l'application est entièrement configurée. */
const discord =
  env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
    ? {
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
        redirectUri: env.DISCORD_REDIRECT_URI,
        apiBase: env.DISCORD_API_BASE,
      }
    : null;

const game = new GameServer({
  game: buzzer,
  logger: consoleLogger,
  roomsPerMinutePerIp: envInt("ROOMS_PER_MINUTE_PER_IP", 10),
  limits: { failedJoinsPerMinute: envInt("FAILED_JOINS_PER_MINUTE", 12) },
  // Les téléphones peuvent envoyer des réactions (emojis) qui s'envolent sur l'écran.
  modules: [controllerModule({ schema: reactionSchema, inputsPerSecond: 3, from: "members" })],
  ...(discord && {
    authenticate: discordAuthenticator({ apiBase: discord.apiBase }),
    // Discord Activity : le salon de l'instance est créé par le premier compte Discord qui arrive.
    createOnJoin: (_code, identity) => identity.provider === DISCORD_PROVIDER,
  }),
});

const serveApp = staticHandler(fileURLToPath(new URL("../dist", import.meta.url)), {
  hsts: production && env.HSTS === "1",
  frameAncestors: env.DISCORD_ACTIVITY === "1" ? DISCORD_FRAME_ANCESTORS : undefined,
});

const discordToken = discord ? toNodeHandler(createDiscordTokenHandler(discord), { trustProxy }) : null;

/** Configuration publique lue par le navigateur (jamais de secret ici). */
const publicConfig = JSON.stringify({
  discord: discord ? { clientId: discord.clientId, authorizeUrl: env.DISCORD_AUTHORIZE_URL } : null,
});

function sendJson(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/healthz") return sendJson(res, 200, JSON.stringify({ ok: true, ...game.stats() }));
  if (path === "/api/config") return sendJson(res, 200, publicConfig);
  if (path === "/api/discord/token") {
    if (!discordToken) return sendJson(res, 404, JSON.stringify({ error: "Discord n'est pas configuré." }));
    discordToken(req, res).catch(() => sendJson(res, 500, JSON.stringify({ error: "Erreur inattendue." })));
    return;
  }
  if (!production) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("En développement, l'application est servie par Vite (http://localhost:5173).");
    return;
  }
  void serveApp(req, res);
}

const http = createServer(route);
const io = new Server(http, secureSocketIoOptions({ allowedOrigins }));
attachSocketIo(io, game, { trustProxy });

http.listen(port, () => {
  consoleLogger.info(`Buzzer ! prêt sur http://localhost:${port}`, {
    production,
    allowedOrigins,
    discord: discord !== null,
  });
});

// Arrêt propre : les joueurs sont prévenus, les connexions fermées.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    game.close();
    void io.close();
    http.close(() => process.exit(0));
  });
}
