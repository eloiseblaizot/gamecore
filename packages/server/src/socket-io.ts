/**
 * Transport Socket.io (serveur Node classique : Fly.io, Railway, Render, VPS…).
 *
 *   import { createServer } from "node:http";
 *   import { Server } from "socket.io";
 *   import { GameServer } from "@gamecore/server";
 *   import { attachSocketIo, secureSocketIoOptions } from "@gamecore/server/socket-io";
 *
 *   const http = createServer();
 *   const io = new Server(http, secureSocketIoOptions({ allowedOrigins: ["https://monjeu.fr"] }));
 *   attachSocketIo(io, new GameServer({ game }));
 *   http.listen(3000);
 *
 * Tous les messages passent par un unique évènement Socket.io, `gc`, sous forme de texte
 * JSON : le serveur applique ensuite exactement les mêmes contrôles qu'avec PartyKit.
 */

import type { IncomingMessage } from "node:http";
import type { Server, ServerOptions, Socket } from "socket.io";
import type { Connection } from "./connection.js";
import type { GameServer } from "./server.js";

/** Nom de l'évènement Socket.io qui transporte le protocole gamecore. */
export const SOCKET_IO_EVENT = "gc";

export interface SocketIoAdapterOptions {
  /**
   * Faire confiance à l'en-tête `X-Forwarded-For` pour l'adresse IP du client.
   * À activer UNIQUEMENT derrière un proxy de confiance (sinon un client peut s'inventer
   * une adresse et contourner la limitation des tentatives).
   */
  trustProxy?: boolean;
}

/** Branche un `GameServer` sur un serveur Socket.io. Renvoie une fonction pour le débrancher. */
export function attachSocketIo(
  io: Server,
  server: GameServer,
  options: SocketIoAdapterOptions = {},
): () => void {
  const onConnection = (socket: Socket) => {
    const headers = socket.handshake.headers;
    const conn: Connection = {
      id: socket.id,
      meta: {
        ip: clientIp(socket, options.trustProxy ?? false),
        origin: typeof headers.origin === "string" ? headers.origin : null,
        userAgent: typeof headers["user-agent"] === "string" ? headers["user-agent"].slice(0, 256) : null,
      },
      send: (data) => {
        socket.emit(SOCKET_IO_EVENT, data);
      },
      close: () => {
        socket.disconnect(true);
      },
    };
    server.connect(conn);
    socket.on(SOCKET_IO_EVENT, (data: unknown) => {
      void server.receive(socket.id, data);
    });
    socket.on("disconnect", () => server.disconnect(socket.id));
  };
  io.on("connection", onConnection);
  return () => {
    io.off("connection", onConnection);
  };
}

export interface SecureSocketIoOptions {
  /**
   * Origines autorisées (ex. `["https://monjeu.fr"]`). Les navigateurs n'appliquent PAS
   * le CORS aux WebSockets : sans ce contrôle, n'importe quel site pourrait ouvrir une
   * connexion au serveur depuis le navigateur d'un visiteur.
   * `"*"` désactive le contrôle (développement uniquement).
   */
  allowedOrigins: readonly string[] | "*";
  /** Taille max d'un paquet Socket.io (64 Kio par défaut ; gamecore limite ensuite chaque message). */
  maxHttpBufferSize?: number;
}

/** Options Socket.io durcies : origines vérifiées, paquets bornés, WebSocket privilégié. */
export function secureSocketIoOptions(options: SecureSocketIoOptions): Partial<ServerOptions> {
  const allowed = options.allowedOrigins;
  const isAllowed = (origin: string | undefined) =>
    allowed === "*" || (origin !== undefined && allowed.includes(origin));
  return {
    maxHttpBufferSize: options.maxHttpBufferSize ?? 64 * 1024,
    cors: allowed === "*" ? { origin: true } : { origin: [...allowed] },
    allowRequest: (
      req: IncomingMessage,
      callback: (err: string | null | undefined, success: boolean) => void,
    ) => {
      const ok = isAllowed(req.headers.origin);
      callback(ok ? null : "Origine non autorisée", ok);
    },
    // Pas de reprise d'état Socket.io : gamecore gère lui-même la reprise de session (jetons).
    connectionStateRecovery: undefined,
    serveClient: false,
  };
}

function clientIp(socket: Socket, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = socket.handshake.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address || null;
}
