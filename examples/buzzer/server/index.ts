/**
 * Serveur du jeu d'exemple : fichiers de l'application + serveur de jeu Socket.io.
 *
 * Variables d'environnement :
 *   PORT             port d'écoute (3001 par défaut)
 *   ALLOWED_ORIGINS  origines autorisées à ouvrir une connexion, séparées par des virgules
 *                    (par défaut : http://localhost:PORT et le serveur de dev Vite)
 *   TRUST_PROXY      « 1 » derrière un proxy de confiance (lecture de X-Forwarded-For)
 *   NODE_ENV         « production » pour servir dist/ (sinon Vite sert l'application)
 */

import { GameServer, consoleLogger, controllerModule } from "@gamecore/server";
import { attachSocketIo, secureSocketIoOptions } from "@gamecore/server/socket-io";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { buzzer } from "../src/game.js";
import { reactionSchema } from "../src/reactions.js";
import { staticHandler } from "./http.js";

const port = Number(process.env.PORT ?? 3001);
const production = process.env.NODE_ENV === "production";
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? `http://localhost:${port},http://localhost:5173`)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const game = new GameServer({
  game: buzzer,
  logger: consoleLogger,
  // Les téléphones peuvent envoyer des réactions (emojis) qui s'envolent sur l'écran.
  modules: [controllerModule({ schema: reactionSchema, inputsPerSecond: 3, from: "members" })],
});

const serveApp = staticHandler(fileURLToPath(new URL("../dist", import.meta.url)), {
  hsts: production && process.env.HSTS === "1",
});

const http = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...game.stats() }));
    return;
  }
  if (!production) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("En développement, l'application est servie par Vite (http://localhost:5173).");
    return;
  }
  void serveApp(req, res);
});

const io = new Server(http, secureSocketIoOptions({ allowedOrigins }));
attachSocketIo(io, game, { trustProxy: process.env.TRUST_PROXY === "1" });

http.listen(port, () => {
  consoleLogger.info(`Buzzer ! prêt sur http://localhost:${port}`, { production, allowedOrigins });
});

// Arrêt propre : les joueurs sont prévenus, les connexions fermées.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    game.close();
    void io.close();
    http.close(() => process.exit(0));
  });
}
