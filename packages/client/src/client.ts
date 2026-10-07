/**
 * `GameClient` : la connexion d'un navigateur (écran, téléphone, PC) à un salon.
 *
 * Il expose un état immuable (`getState`) et un abonnement (`subscribe`), compatibles
 * avec `useSyncExternalStore` de React mais utilisables sans framework. Il gère seul :
 *   - la corrélation requête → réponse (`ack` / `error`) avec délai d'expiration ;
 *   - la reprise de session après une coupure réseau (jeton mémorisé) ;
 *   - l'ordre des états reçus (une version plus ancienne est ignorée) ;
 *   - l'estimation du décalage d'horloge avec le serveur, pour des comptes à rebours justes.
 */

import {
  GameError,
  PROTOCOL_VERSION,
  type AnyGame,
  type ByeReason,
  type ChatMessage,
  type ErrorCode,
  type GameSnapshot,
  type GameTypes,
  type LobbyOp,
  type MemberRole,
  type RoomInfo,
  type ServerMessage,
  type Welcome,
  type You,
} from "@gamecore/core";
import { Emitter } from "./emitter.js";
import { browserSessionStore, readSession, type SessionStore, type StoredSession } from "./storage.js";
import type { ClientTransport } from "./transport.js";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

type Pub<G> = [G] extends [AnyGame] ? GameTypes<G>["publicView"] : unknown;
type Priv<G> = [G] extends [AnyGame] ? GameTypes<G>["privateView"] : unknown;
type Settings<G> = [G] extends [AnyGame] ? GameTypes<G>["settings"] : unknown;
type Action<G> = [G] extends [AnyGame] ? GameTypes<G>["action"] : unknown;

export interface ClientState<G = AnyGame> {
  status: ConnectionStatus;
  /** Le salon où je suis (confirmé par le serveur), ou `null`. */
  session: { code: string; kind: You["kind"]; memberId: string | null } | null;
  room: RoomInfo<Settings<G>> | null;
  you: You | null;
  game: GameSnapshot<Pub<G>, Priv<G>> | null;
  /** Version de l'état reçu (augmente à chaque changement). */
  version: number;
  /** Pourquoi la session s'est terminée (expulsion, salon fermé…), le cas échéant. */
  bye: ByeReason | null;
  /** Dernière erreur reçue hors requête (ex. débit dépassé). */
  lastError: { code: ErrorCode; message: string } | null;
}

export interface GameClientOptions {
  transport: ClientTransport;
  /** Où mémoriser les jetons (`sessionStorage` par défaut, `null` pour ne rien mémoriser). */
  storage?: SessionStore | null;
  /** Délai max d'attente d'une réponse (10 s par défaut). */
  requestTimeoutMs?: number;
  /** Préfixe des clés de stockage (« gamecore » par défaut). */
  storageKey?: string;
}

type ClientEvents = {
  /** Évènement éphémère émis par le jeu (son, animation…). */
  event: [name: string, data: unknown];
  /** Entrée de manette relayée (côté écran). */
  input: [from: string, data: unknown];
  chat: [message: ChatMessage];
  /** Fin de session. */
  bye: [reason: ByeReason];
  /** Erreur reçue hors requête. */
  error: [error: GameError];
};

interface Pending {
  resolve(data: unknown): void;
  reject(error: GameError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ce qui permet de revenir dans le salon après une reconnexion. */
type Rejoin =
  { code: string; kind: "member"; token: string } | { code: string; kind: "screen"; token: string | null };

const initialState: ClientState<never> = {
  status: "idle",
  session: null,
  room: null,
  you: null,
  game: null,
  version: 0,
  bye: null,
  lastError: null,
};

export class GameClient<G = AnyGame> {
  private state: ClientState<G> = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly emitter = new Emitter<ClientEvents>();
  private readonly pending = new Map<number, Pending>();
  private readonly transport: ClientTransport;
  private readonly storage: SessionStore | null;
  private readonly timeoutMs: number;
  private readonly keyPrefix: string;
  /** Messages en attente de l'ouverture de la connexion. */
  private outbox: string[] = [];
  private nextId = 1;
  private open = false;
  private everOpened = false;
  private rejoin: Rejoin | null = null;
  /** Estimation de (heure serveur − heure locale), en ms. */
  private clockOffset = 0;

  constructor(options: GameClientOptions) {
    this.transport = options.transport;
    this.storage = options.storage === undefined ? browserSessionStore() : options.storage;
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.keyPrefix = options.storageKey ?? "gamecore";
  }

  // --- État ---------------------------------------------------------------------

  getState = (): ClientState<G> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Abonnement aux évènements (jeu, manettes, chat, fin de session, erreurs). */
  on<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  /** Heure du serveur estimée (ms), pour afficher un compte à rebours fidèle. */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  // --- Connexion ------------------------------------------------------------------

  /** Ouvre la connexion (sans effet si elle l'est déjà). Appelée automatiquement au besoin. */
  connect(): void {
    if (this.state.status !== "idle" && this.state.status !== "closed") return;
    this.update({ status: "connecting" });
    this.transport.connect({
      open: () => this.onOpen(),
      message: (data) => this.onMessage(data),
      close: () => this.onClose(),
    });
  }

  /** Ferme définitivement la connexion. */
  close(): void {
    this.transport.close();
    this.open = false;
    this.rejectAll("DISCONNECTED", "Connexion fermée.");
    this.rejoin = null;
    this.update({ status: "closed" });
  }

  // --- Entrer, sortir --------------------------------------------------------------

  /** Crée un salon en tant qu'écran partagé (télé, PC) ou en tant que joueur (qui en devient l'host). */
  async create(
    as: "screen" | "player",
    options: {
      profile?: { name: string; avatar?: string | null };
      settings?: Partial<Settings<G>>;
      /** Preuve d'identité du créateur-joueur (ex. jeton Discord). */
      credential?: string;
    } = {},
  ): Promise<Welcome> {
    const welcome = await this.request<Welcome>({
      t: "create",
      v: PROTOCOL_VERSION,
      as,
      profile: options.profile,
      settings: options.settings,
      credential: options.credential,
    });
    this.enter(welcome);
    return welcome;
  }

  /**
   * Rejoint un salon avec un pseudo (ou une preuve d'identité, ex. Discord).
   * `create: true` demande au serveur de créer le salon s'il n'existe pas (s'il l'autorise,
   * voir `createOnJoin` : cas des Discord Activities).
   */
  async join(
    code: string,
    profile: { name: string; avatar?: string | null },
    options: { spectator?: boolean; credential?: string; create?: boolean } = {},
  ): Promise<Welcome> {
    const welcome = await this.request<Welcome>({
      t: "join",
      v: PROTOCOL_VERSION,
      code,
      profile,
      spectator: options.spectator,
      credential: options.credential,
      create: options.create,
    });
    this.enter(welcome);
    return welcome;
  }

  /** Branche cet appareil comme écran partagé d'un salon existant. */
  async watch(code: string, adminToken?: string): Promise<Welcome> {
    const welcome = await this.request<Welcome>({ t: "watch", v: PROTOCOL_VERSION, code, adminToken });
    this.enter({ ...welcome, token: adminToken });
    return welcome;
  }

  /**
   * Reprend la session mémorisée pour ce salon (après un rechargement de page).
   * Renvoie `null` s'il n'y a rien à reprendre ou si la session a expiré.
   */
  async resume(code: string): Promise<Welcome | null> {
    const stored = this.stored(code);
    if (!stored) return null;
    try {
      const welcome = await this.sendRejoin(
        stored.kind === "screen"
          ? { code: stored.code, kind: "screen", token: stored.token }
          : { code: stored.code, kind: "member", token: stored.token ?? "" },
      );
      this.enter({ ...welcome, token: stored.token ?? undefined });
      return welcome;
    } catch (err) {
      if (err instanceof GameError && ["UNAUTHORIZED", "NOT_FOUND", "FORBIDDEN"].includes(err.code)) {
        this.forget(code);
        return null;
      }
      throw err;
    }
  }

  /** Session mémorisée pour ce salon, s'il y en a une. */
  stored(code: string): StoredSession | null {
    return readSession(this.storage, this.key(code));
  }

  /** Quitte définitivement le salon. */
  async leave(): Promise<void> {
    const code = this.state.session?.code;
    try {
      await this.request({ t: "leave" });
    } finally {
      if (code) this.forget(code);
      this.rejoin = null;
      this.update({ session: null, room: null, you: null, game: null, version: 0 });
    }
  }

  // --- Jouer ------------------------------------------------------------------------

  /** Envoie une action de jeu ; la promesse est rejetée (GameError) si les règles la refusent. */
  async act(action: Action<G>): Promise<void> {
    await this.request({ t: "action", action });
  }

  /** Opérations de salon (host), et changement de rôle (soi-même). */
  readonly lobby = {
    start: () => this.lobbyOp({ op: "start" }),
    settings: (settings: Partial<Settings<G>>) => this.lobbyOp({ op: "settings", settings }),
    kick: (memberId: string) => this.lobbyOp({ op: "kick", memberId }),
    promote: (memberId: string) => this.lobbyOp({ op: "promote", memberId }),
    role: (role: MemberRole) => this.lobbyOp({ op: "role", role }),
    lock: (locked: boolean) => this.lobbyOp({ op: "lock", locked }),
    end: () => this.lobbyOp({ op: "end" }),
  };

  /** Entrée de manette temps réel (module « controller ») : sans réponse, perdue si hors ligne. */
  sendInput(data: unknown): void {
    if (!this.open) return;
    this.transport.send(JSON.stringify({ t: "input", data }));
  }

  /** Message de chat (module « chat »). */
  async chat(body: string, channel?: string): Promise<void> {
    await this.request({ t: "chat", body, channel });
  }

  /** Mesure l'aller-retour (ms) et recale l'horloge du serveur. */
  async ping(): Promise<number> {
    const sent = Date.now();
    const { now } = await this.request<{ now: number }>({ t: "ping" });
    const received = Date.now();
    this.clockOffset = now - (sent + received) / 2;
    return received - sent;
  }

  // --- Interne ----------------------------------------------------------------------

  private lobbyOp(op: LobbyOp): Promise<void> {
    return this.request({ t: "lobby", op }).then(() => undefined);
  }

  /** Envoie une requête et attend sa réponse. */
  private request<T = unknown>(message: Record<string, unknown>): Promise<T> {
    this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GameError("TIMEOUT", "Le serveur ne répond pas, vérifie ta connexion."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (data) => resolve(data as T), reject, timer });
      this.sendRaw(JSON.stringify({ ...message, id }));
    });
  }

  private sendRaw(data: string): void {
    if (this.open) this.transport.send(data);
    else this.outbox.push(data);
  }

  private enter(welcome: Welcome): void {
    this.update({
      session: { code: welcome.code, kind: welcome.kind, memberId: welcome.memberId },
      bye: null,
    });
    const token = welcome.token ?? null;
    if (welcome.kind === "screen") {
      this.rejoin = { code: welcome.code, kind: "screen", token };
    } else if (token !== null) {
      this.rejoin = { code: welcome.code, kind: "member", token };
    }
    if (this.rejoin) {
      const stored: StoredSession = { code: welcome.code, kind: welcome.kind, token: this.rejoin.token };
      this.storage?.set(this.key(welcome.code), JSON.stringify(stored));
    }
  }

  private sendRejoin(rejoin: Rejoin): Promise<Welcome> {
    return rejoin.kind === "screen"
      ? this.request<Welcome>({
          t: "watch",
          v: PROTOCOL_VERSION,
          code: rejoin.code,
          adminToken: rejoin.token ?? undefined,
        })
      : this.request<Welcome>({ t: "resume", v: PROTOCOL_VERSION, code: rejoin.code, token: rejoin.token });
  }

  private onOpen(): void {
    const reconnecting = this.everOpened;
    this.open = true;
    this.everOpened = true;
    this.update({ status: "connected" });
    // Après une coupure, on reprend sa place AVANT d'envoyer quoi que ce soit d'autre.
    if (reconnecting && this.rejoin) {
      const rejoin = this.rejoin;
      this.sendRejoin(rejoin).catch((err: unknown) => {
        if (err instanceof GameError && ["UNAUTHORIZED", "NOT_FOUND", "FORBIDDEN"].includes(err.code)) {
          this.forget(rejoin.code);
          this.rejoin = null;
          this.update({ session: null, room: null, you: null, game: null, bye: "closed" });
          this.emitter.emit("bye", "closed");
        }
      });
    }
    const queued = this.outbox;
    this.outbox = [];
    for (const data of queued) this.transport.send(data);
    void this.ping().catch(() => undefined);
  }

  private onClose(): void {
    this.open = false;
    this.rejectAll("DISCONNECTED", "Connexion perdue.");
    if (this.state.status !== "closed") this.update({ status: "reconnecting" });
  }

  private onMessage(data: string): void {
    let message: ServerMessage<Pub<G>, Priv<G>, Settings<G>>;
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null || typeof message.t !== "string") return;

    switch (message.t) {
      case "ack": {
        const pending = this.pending.get(message.ref);
        if (!pending) return;
        this.pending.delete(message.ref);
        clearTimeout(pending.timer);
        pending.resolve(message.data);
        return;
      }
      case "error": {
        const error = new GameError(message.code, message.message);
        const pending = message.ref !== undefined ? this.pending.get(message.ref) : undefined;
        if (pending && message.ref !== undefined) {
          this.pending.delete(message.ref);
          clearTimeout(pending.timer);
          pending.reject(error);
        } else {
          this.update({ lastError: { code: message.code, message: message.message } });
          this.emitter.emit("error", error);
        }
        return;
      }
      case "sync": {
        const sameRoom = this.state.room?.code === message.room.code;
        // Les états d'un même salon arrivent dans l'ordre, mais on se protège d'un doublon.
        if (sameRoom && message.version <= this.state.version) return;
        this.update({ room: message.room, you: message.you, game: message.game, version: message.version });
        return;
      }
      case "event":
        this.emitter.emit("event", message.name, message.data);
        return;
      case "input":
        this.emitter.emit("input", message.from, message.data);
        return;
      case "chat":
        this.emitter.emit("chat", message.message);
        return;
      case "bye": {
        const code = this.state.session?.code ?? this.state.room?.code;
        // « replaced » : un autre onglet a pris la place, on ne touche pas à sa session.
        if (code && message.reason !== "replaced") this.forget(code);
        this.rejoin = null;
        this.update({ session: null, room: null, you: null, game: null, version: 0, bye: message.reason });
        this.emitter.emit("bye", message.reason);
        return;
      }
    }
  }

  private rejectAll(code: ErrorCode, text: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new GameError(code, text));
      this.pending.delete(id);
    }
  }

  private forget(code: string): void {
    this.storage?.remove(this.key(code));
  }

  private key(code: string): string {
    return `${this.keyPrefix}:session:${code.toUpperCase()}`;
  }

  private update(patch: Partial<ClientState<G>>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
