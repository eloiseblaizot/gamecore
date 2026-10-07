/**
 * Transport local : le serveur tourne dans la même page que le client.
 *
 * Sert au mode démo (une partie complète dans le navigateur, contre des bots, sans aucun
 * serveur), et aux tests. Le serveur exécuté est EXACTEMENT celui de production : mêmes
 * règles, mêmes validations, mêmes vues ; seul le transport change.
 *
 *   const server = new GameServer({ game });
 *   const client = new GameClient({ transport: localTransport(server), storage: null });
 */

import type { Connection, GameServer } from "@gamecore/server";
import type { ClientTransport } from "./transport.js";

let seq = 0;

export interface LocalTransportOptions {
  /** Latence simulée (ms) dans chaque sens, 0 par défaut (asynchrone malgré tout). */
  latencyMs?: number;
}

export function localTransport(server: GameServer, options: LocalTransportOptions = {}): ClientTransport {
  const latency = options.latencyMs ?? 0;
  const later = (fn: () => void) => {
    if (latency > 0) setTimeout(fn, latency);
    else queueMicrotask(fn);
  };
  let conn: Connection | null = null;

  return {
    connect(handlers) {
      const id = `local-${++seq}`;
      const current: Connection = {
        id,
        meta: { ip: null, origin: null, userAgent: null },
        send: (data) => later(() => conn === current && handlers.message(data)),
        close: () => {
          if (conn !== current) return;
          conn = null;
          later(handlers.close);
        },
      };
      conn = current;
      server.connect(current);
      later(handlers.open);
    },
    send(data) {
      const current = conn;
      if (current) later(() => void server.receive(current.id, data));
    },
    close() {
      if (conn) server.disconnect(conn.id);
      conn = null;
    },
  };
}
