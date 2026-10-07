/**
 * Outils pour tester un jeu de bout en bout côté serveur, sans réseau :
 *
 *   import { createTestServer } from "@gamecore/server/testing";
 *
 *   const { client } = createTestServer({ game: monJeu });
 *   const screen = client();
 *   const { code } = await screen.create("screen");
 *   const alice = client();
 *   await alice.join(code, "Alice");
 *   await screen.lobby({ op: "start" });
 *   await alice.act({ type: "answer", choice: 2 });
 *   expect(screen.sync().game?.public).toMatchObject({ ... });
 *
 * Chaque client de test enregistre tous les messages reçus ; `request` attend que le
 * serveur ait fini de traiter le message, aucun délai arbitraire n'est nécessaire.
 */

import {
  GameError,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type LobbyOp,
  type ServerMessage,
  type Welcome,
} from "@gamecore/core";
import type { Connection, ConnectionMeta } from "./connection.js";
import { silentLogger } from "./logger.js";
import { GameServer, type GameServerOptions } from "./server.js";

export type SyncMessage<Pub = unknown, Priv = unknown, Settings = unknown> = Extract<
  ServerMessage<Pub, Priv, Settings>,
  { t: "sync" }
>;

/** Connexion factice qui enregistre ce que le serveur lui envoie. */
export class TestConnection implements Connection {
  readonly id: string;
  readonly meta: ConnectionMeta;
  readonly received: ServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(id: string, meta: Partial<ConnectionMeta> = {}) {
    this.id = id;
    this.meta = { ip: meta.ip ?? null, origin: meta.origin ?? null, userAgent: meta.userAgent ?? null };
  }

  send(data: string): void {
    this.received.push(JSON.parse(data) as ServerMessage);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

/** Requête sans identifiant ni version : le client de test les ajoute. */
type Request = ClientMessage extends infer M
  ? M extends ClientMessage
    ? Omit<M, "id" | "v">
    : never
  : never;

export class TestClient<Pub = unknown, Priv = unknown, Settings = unknown> {
  readonly conn: TestConnection;
  private readonly server: GameServer;
  private nextId = 1;

  constructor(server: GameServer, conn: TestConnection) {
    this.server = server;
    this.conn = conn;
  }

  /** Envoie un texte brut, tel quel (pour tester les messages malveillants). */
  async raw(data: unknown): Promise<void> {
    await this.server.receive(this.conn.id, data);
  }

  /** Envoie une requête ; renvoie les données de l'`ack`, ou lève une `GameError`. */
  async request<T = unknown>(message: Request): Promise<T> {
    const id = this.nextId++;
    const full = {
      ...message,
      id,
      ...("code" in message || message.t === "create" ? { v: PROTOCOL_VERSION } : {}),
    };
    await this.server.receive(this.conn.id, JSON.stringify(full));
    const reply = this.conn.received.find((m) => (m.t === "ack" || m.t === "error") && m.ref === id) as
      Extract<ServerMessage, { t: "ack" | "error" }> | undefined;
    if (!reply) throw new Error(`Aucune réponse à la requête ${id} (${message.t}).`);
    if (reply.t === "error") throw new GameError(reply.code, reply.message);
    return reply.data as T;
  }

  /** Comme `request`, mais renvoie le code d'erreur attendu (et échoue si la requête réussit). */
  async expectError(message: Request): Promise<ErrorCode> {
    try {
      await this.request(message);
    } catch (err) {
      if (err instanceof GameError) return err.code;
      throw err;
    }
    throw new Error(`La requête ${message.t} aurait dû échouer.`);
  }

  create(as: "screen" | "player", name?: string, settings?: Record<string, unknown>): Promise<Welcome> {
    return this.request<Welcome>({ t: "create", as, profile: name ? { name } : undefined, settings });
  }

  join(code: string, name: string, options: { spectator?: boolean; avatar?: string } = {}): Promise<Welcome> {
    return this.request<Welcome>({
      t: "join",
      code,
      profile: { name, avatar: options.avatar },
      spectator: options.spectator,
    });
  }

  resume(code: string, token: string): Promise<Welcome> {
    return this.request<Welcome>({ t: "resume", code, token });
  }

  watch(code: string, adminToken?: string): Promise<Welcome> {
    return this.request<Welcome>({ t: "watch", code, adminToken });
  }

  lobby(op: LobbyOp): Promise<unknown> {
    return this.request({ t: "lobby", op });
  }

  act(action: unknown): Promise<unknown> {
    return this.request({ t: "action", action });
  }

  /** Dernier état reçu (lève une erreur s'il n'y en a pas). */
  sync(): SyncMessage<Pub, Priv, Settings> {
    const all = this.messages("sync");
    const last = all[all.length - 1];
    if (!last) throw new Error("Aucune synchronisation reçue.");
    return last as unknown as SyncMessage<Pub, Priv, Settings>;
  }

  /** Tous les messages reçus d'un type donné. */
  messages<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.conn.received.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }

  /** Vide l'historique des messages reçus. */
  clear(): void {
    this.conn.received.length = 0;
  }

  /** Simule une coupure réseau. */
  disconnect(): void {
    this.server.disconnect(this.conn.id);
  }
}

export interface TestServer {
  server: GameServer;
  /** Ouvre une nouvelle connexion de test (fonction fléchée : peut être déstructurée). */
  client: <Pub = unknown, Priv = unknown, Settings = unknown>(
    meta?: Partial<ConnectionMeta>,
  ) => TestClient<Pub, Priv, Settings>;
}

/** Serveur de test, silencieux par défaut. */
export function createTestServer(options: GameServerOptions): TestServer {
  const server = new GameServer({ logger: silentLogger, ...options });
  let seq = 0;
  return {
    server,
    client: <Pub, Priv, Settings>(meta?: Partial<ConnectionMeta>) => {
      const conn = new TestConnection(`test-${++seq}`, meta);
      server.connect(conn);
      return new TestClient<Pub, Priv, Settings>(server, conn);
    },
  };
}
