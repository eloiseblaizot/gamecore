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

import type { AnyGame, Welcome } from "@gamecore/core";
import { GameServer, silentLogger, type Connection, type GameServerOptions } from "@gamecore/server";
import { GameClient } from "./client.js";
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

export interface DemoRoomOptions<G extends AnyGame> extends Omit<GameServerOptions, "game"> {
  game: G;
  /** Le joueur humain. */
  player: { name: string; avatar?: string | null };
  /** Nombre de bots à ajouter (3 par défaut). */
  bots?: number;
  /** Ajouter un écran partagé (vue publique, droits d'admin) ? Oui par défaut. */
  screen?: boolean;
  /** Réglages de la partie. */
  settings?: Record<string, unknown>;
  /** Latence simulée du transport local (ms). */
  latencyMs?: number;
}

export interface DemoRoom<G> {
  code: string;
  server: GameServer;
  /** L'écran partagé (admin), ou `null` si `screen: false`. */
  screen: GameClient<G> | null;
  /** Le joueur humain (host de la partie lui aussi). */
  player: GameClient<G>;
  /** Arrête tout (connexions et serveur). */
  close(): void;
}

/**
 * Mode démo clé en main : un serveur dans la page, un écran, le joueur humain et des bots.
 * Rien ne sort du navigateur ; le serveur exécuté est exactement celui de production.
 *
 *   const demo = await createDemoRoom({ game: monJeu, player: { name: "Toi" }, bots: 3 });
 *   <GameProvider client={demo.player}>…</GameProvider>
 */
export async function createDemoRoom<G extends AnyGame>(options: DemoRoomOptions<G>): Promise<DemoRoom<G>> {
  const {
    game,
    player: profile,
    bots = 3,
    screen: withScreen = true,
    settings,
    latencyMs,
    ...serverOptions
  } = options;
  const server = new GameServer({ logger: silentLogger, ...serverOptions, game });
  const make = () => new GameClient<G>({ transport: localTransport(server, { latencyMs }), storage: null });

  const player = make();
  let screen: GameClient<G> | null = null;
  let welcome: Welcome;
  if (withScreen) {
    screen = make();
    const created = await screen.create("screen", { settings });
    welcome = await player.join(created.code, profile);
  } else {
    welcome = await player.create("player", { profile, settings });
  }
  const admin = screen ?? player;
  for (let i = 0; i < bots; i++) await admin.lobby.addBot();

  return {
    code: welcome.code,
    server,
    screen,
    player,
    close() {
      player.close();
      screen?.close();
      server.close();
    },
  };
}
