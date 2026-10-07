/**
 * `GameServer` : point d'entrée unique des transports, et gardien de la sécurité.
 *
 * Chaque message reçu traverse, dans l'ordre :
 *   1. un contrôle de taille (`maxMessageBytes`) ;
 *   2. un limiteur de débit anti-inondation, AVANT toute analyse ;
 *   3. l'analyse JSON puis la validation stricte par le schéma du protocole ;
 *   4. un second limiteur pour les messages « coûteux » (tout sauf les entrées de manette) ;
 *   5. le routage vers le salon, qui vérifie les droits (host, joueur…) et les règles.
 * Les infractions répétées (messages illisibles, débit dépassé…) ferment la connexion.
 *
 * Les tentatives d'entrée ratées (code inconnu, jeton invalide) sont comptées par adresse
 * IP : au-delà de `failedJoinsPerMinute`, l'adresse doit patienter. Deviner le code d'une
 * partie privée devient ainsi irréaliste.
 */

import {
  DEFAULT_AVATAR_POLICY,
  DEFAULT_LIMITS,
  GameError,
  INTERNAL_ERROR_MESSAGE,
  byteLength,
  clientMessageSchema,
  generateRoomCode,
  generateToken,
  hashToken,
  isRoomCode,
  normalizeRoomCode,
  randomSeed,
  resolveSettings,
  sanitizeAvatar,
  sanitizeDisplayName,
  seedFromString,
  type AnyGame,
  type AvatarPolicy,
  type ClientMessage,
  type Limits,
  type ServerMessage,
  type Welcome,
} from "@gamecore/core";
import { systemClock, type Clock } from "./clock.js";
import type { Authenticator, Connection } from "./connection.js";
import { consoleLogger, type Logger } from "./logger.js";
import type { ServerModule } from "./modules/module.js";
import { SlidingWindowCounter, TokenBucket } from "./rate-limit.js";
import { Room, type Identity } from "./room.js";

export interface GameServerOptions {
  /** Le jeu servi par ce serveur. */
  game: AnyGame;
  /** Modules activés (manettes, chat…). */
  modules?: readonly ServerModule[];
  /** Limites de sécurité (voir `DEFAULT_LIMITS`). */
  limits?: Partial<Limits>;
  clock?: Clock;
  logger?: Logger;
  /**
   * Vérifie une preuve d'identité (`credential` du message `join`), par exemple un jeton
   * Discord. Sans cette fonction, seuls les invités sont acceptés.
   */
  authenticate?: Authenticator;
  /** Refuser les invités : une identité vérifiée est obligatoire. */
  requireAuth?: boolean;
  /** Avatars autorisés (emojis et hôtes HTTPS), voir `sanitizeAvatar`. */
  avatarPolicy?: AvatarPolicy;
  /** Délai avant de libérer la place d'un membre déconnecté hors partie (2 min par défaut). */
  lobbyGraceMs?: number;
  /** Délai avant de fermer un salon vide (10 min par défaut). */
  emptyRoomTtlMs?: number;
  /** Nombre max de salons simultanés (1000 par défaut). */
  maxRooms?: number;
  /** Salons créés par minute et par adresse IP (10 par défaut). */
  roomsPerMinutePerIp?: number;
  /** Les clients peuvent-ils créer des salons ? (Oui par défaut.) */
  allowCreate?: boolean;
  allowSpectators?: boolean;
  /** Un écran sans jeton d'administration peut-il se brancher ? (Oui par défaut : vue publique.) */
  allowAnonymousScreens?: boolean;
  /** Infractions tolérées par minute avant de fermer la connexion (10 par défaut). */
  maxViolationsPerMinute?: number;
}

interface Client {
  conn: Connection;
  room: Room | null;
  /** Anti-inondation, avant analyse : tous les messages. */
  floodBucket: TokenBucket;
  /** Messages coûteux (tout sauf les entrées de manette). */
  messageBucket: TokenBucket;
  violations: number[];
}

/** Code WebSocket « violation de politique ». */
const POLICY_VIOLATION = 1008;

export class GameServer {
  readonly game: AnyGame;
  readonly limits: Limits;

  private readonly clients = new Map<string, Client>();
  private readonly rooms = new Map<string, Room>();
  private readonly disposals = new Map<string, unknown>();
  private readonly failedJoins: SlidingWindowCounter;
  private readonly createdRooms: SlidingWindowCounter;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly options: GameServerOptions;

  constructor(options: GameServerOptions) {
    this.options = options;
    this.game = options.game;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
    const now = () => this.clock.now();
    this.failedJoins = new SlidingWindowCounter(this.limits.failedJoinsPerMinute, 60_000, now);
    this.createdRooms = new SlidingWindowCounter(options.roomsPerMinutePerIp ?? 10, 60_000, now);
    const names = (options.modules ?? []).map((m) => m.name);
    if (new Set(names).size !== names.length) throw new Error("Deux modules portent le même nom.");
  }

  // --- API des transports ----------------------------------------------------

  /** Une nouvelle connexion est ouverte. */
  connect(conn: Connection): void {
    if (this.clients.has(conn.id)) this.disconnect(conn.id);
    const now = () => this.clock.now();
    const { messagesPerSecond, messageBurst, inputsPerSecond } = this.limits;
    this.clients.set(conn.id, {
      conn,
      room: null,
      floodBucket: new TokenBucket(messagesPerSecond + inputsPerSecond, messageBurst + inputsPerSecond, now),
      messageBucket: new TokenBucket(messagesPerSecond, messageBurst, now),
      violations: [],
    });
  }

  /**
   * Un message est arrivé. La promesse se résout une fois le message entièrement traité
   * (utile aux tests) ; un transport peut l'ignorer, elle ne rejette jamais.
   */
  async receive(connectionId: string, raw: unknown): Promise<void> {
    const client = this.clients.get(connectionId);
    if (!client) return;

    if (typeof raw !== "string")
      return this.violation(client, "BAD_REQUEST", "Format de message non pris en charge.");
    // `raw.length` (unités UTF-16) minore la taille en octets : test rapide avant le calcul exact.
    if (raw.length > this.limits.maxMessageBytes || byteLength(raw) > this.limits.maxMessageBytes) {
      return this.violation(client, "PAYLOAD_TOO_LARGE", "Message trop volumineux.");
    }
    if (!client.floodBucket.take())
      return this.violation(client, "RATE_LIMITED", "Trop de messages, ralentis !");

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.violation(client, "BAD_REQUEST", "Message illisible.");
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) return this.violation(client, "BAD_REQUEST", "Message invalide.", requestIdOf(json));
    const message = parsed.data;
    const ref = "id" in message ? message.id : undefined;

    if (message.t !== "input" && !client.messageBucket.take()) {
      return this.violation(client, "RATE_LIMITED", "Trop de messages, ralentis !", ref);
    }

    try {
      const data = await this.dispatch(client, message);
      if (ref !== undefined) this.send(client, { t: "ack", ref, data });
    } catch (err) {
      const error = err instanceof GameError ? err : new GameError("INTERNAL", INTERNAL_ERROR_MESSAGE);
      if (!(err instanceof GameError)) {
        this.logger.error("erreur inattendue", {
          type: message.t,
          cause: err instanceof Error ? err.stack : String(err),
        });
      }
      this.send(client, { t: "error", ref, code: error.code, message: error.message });
    }
  }

  /** La connexion est fermée. Le membre garde sa place quelque temps (voir `lobbyGraceMs`). */
  disconnect(connectionId: string): void {
    const client = this.clients.get(connectionId);
    if (!client) return;
    this.clients.delete(connectionId);
    client.room?.detach(connectionId);
  }

  // --- Administration --------------------------------------------------------

  /**
   * Crée un salon (par exemple depuis une route HTTP, ou avec un code imposé pour PartyKit).
   * Renvoie aussi le jeton d'administration des écrans : à transmettre au seul créateur.
   */
  async createRoom(options: { code?: string; settings?: unknown; seed?: string } = {}): Promise<{
    room: Room;
    adminToken: string;
  }> {
    if (this.rooms.size >= (this.options.maxRooms ?? 1000)) {
      throw new GameError("RATE_LIMITED", "Le serveur est complet, réessaie dans quelques minutes.");
    }
    const code = options.code !== undefined ? normalizeRoomCode(options.code) : this.freeCode();
    if (!isRoomCode(code)) throw new GameError("BAD_REQUEST", "Code de salon invalide.");
    if (this.rooms.has(code)) throw new GameError("BAD_REQUEST", "Ce code de salon est déjà utilisé.");

    const settings = resolveSettings(this.game, this.game.settings.defaults, options.settings);
    if (!settings.ok) throw settings.error;

    const adminToken = generateToken();
    const adminHash = await hashToken(adminToken);
    if (this.rooms.has(code)) throw new GameError("BAD_REQUEST", "Ce code de salon est déjà utilisé.");

    const room = new Room({
      code,
      game: this.game,
      settings: settings.settings,
      rng: seedFromString(options.seed ?? randomSeed()),
      modules: this.options.modules ?? [],
      limits: this.limits,
      clock: this.clock,
      logger: this.logger,
      lobbyGraceMs: this.options.lobbyGraceMs ?? 120_000,
      allowSpectators: this.options.allowSpectators ?? true,
      allowAnonymousScreens: this.options.allowAnonymousScreens ?? true,
      onIdleChange: (r, idle) => this.onIdleChange(r, idle),
      onRelease: (id) => {
        const client = this.clients.get(id);
        if (client?.room === room) client.room = null;
      },
    });
    room.setAdminTokenHash(adminHash);
    this.rooms.set(code, room);
    // Un salon créé mais jamais rejoint finit par disparaître.
    this.onIdleChange(room, true);
    this.logger.info("salon créé", { room: code });
    return { room, adminToken };
  }

  /** Le salon de ce code, s'il existe. */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(normalizeRoomCode(code));
  }

  /** Ferme un salon immédiatement (tout le monde reçoit `bye`). */
  closeRoom(code: string): void {
    const room = this.getRoom(code);
    if (!room) return;
    this.cancelDisposal(room.code);
    this.rooms.delete(room.code);
    room.dispose("closed");
    this.logger.info("salon fermé", { room: room.code });
  }

  /** Arrête le serveur : ferme tous les salons. */
  close(): void {
    for (const code of [...this.rooms.keys()]) this.closeRoom(code);
    this.clients.clear();
  }

  stats(): { rooms: number; connections: number } {
    return { rooms: this.rooms.size, connections: this.clients.size };
  }

  // --- Routage -----------------------------------------------------------------

  private async dispatch(client: Client, message: ClientMessage): Promise<unknown> {
    switch (message.t) {
      case "ping":
        // L'heure du serveur permet aux clients d'afficher des comptes à rebours justes.
        return { now: this.clock.now() };
      case "create":
        return this.create(client, message);
      case "join":
        return this.join(client, message);
      case "resume":
        return this.enter(client, message.code, (room) => room.resume(client.conn, message.token));
      case "watch":
        return this.enter(client, message.code, (room) => room.watch(client.conn, message.adminToken));
      default:
        if (!client.room) throw new GameError("BAD_REQUEST", "Rejoins d'abord un salon.");
        return client.room.handle(client.conn.id, message);
    }
  }

  private async create(client: Client, message: Extract<ClientMessage, { t: "create" }>): Promise<Welcome> {
    if (this.options.allowCreate === false)
      throw new GameError("FORBIDDEN", "La création de salon est désactivée.");
    const key = this.ipKey(client);
    if (this.createdRooms.isLimited(key)) {
      throw new GameError("RATE_LIMITED", "Trop de salons créés, réessaie dans une minute.");
    }
    // Valider le profil AVANT de créer le salon, pour ne pas laisser de salon orphelin.
    const identity = message.as === "player" ? this.guestIdentity(message.profile) : null;
    this.createdRooms.record(key);
    const { room, adminToken } = await this.createRoom({ settings: message.settings });
    if (identity) {
      return this.bind(client, room, () => room.join(client.conn, identity, { host: true }));
    }
    const welcome = await this.bind(client, room, () => room.watch(client.conn, adminToken));
    return { ...welcome, token: adminToken };
  }

  private async join(client: Client, message: Extract<ClientMessage, { t: "join" }>): Promise<Welcome> {
    return this.enter(client, message.code, async (room) => {
      let identity: Identity;
      if (message.credential !== undefined) {
        if (!this.options.authenticate)
          throw new GameError("BAD_REQUEST", "Connexion par compte non prise en charge.");
        const verified = await this.options
          .authenticate(message.credential, client.conn.meta)
          .catch((err: unknown) => {
            this.logger.warn("échec de la vérification d'identité", { cause: String(err) });
            return null;
          });
        if (!verified) throw new GameError("UNAUTHORIZED", "Identification refusée.");
        identity = {
          provider: verified.provider,
          externalId: verified.externalId,
          name: sanitizeDisplayName(verified.name) ?? "Joueur",
          avatar: sanitizeAvatar(verified.avatar ?? null, this.options.avatarPolicy ?? DEFAULT_AVATAR_POLICY),
        };
      } else {
        identity = this.guestIdentity(message.profile);
      }
      return room.join(client.conn, identity, { spectator: message.spectator });
    });
  }

  /**
   * Entrée dans un salon existant (join, resume, watch), avec le comptage des échecs par
   * adresse IP qui protège les codes de salon contre la force brute.
   */
  private async enter(
    client: Client,
    rawCode: string,
    fn: (room: Room) => Promise<Welcome>,
  ): Promise<Welcome> {
    const key = this.ipKey(client);
    if (this.failedJoins.isLimited(key)) {
      throw new GameError("RATE_LIMITED", "Trop de tentatives, réessaie dans une minute.");
    }
    const room = this.rooms.get(normalizeRoomCode(rawCode));
    try {
      if (!room) throw new GameError("NOT_FOUND", "Salon introuvable, vérifie le code !");
      return await this.bind(client, room, () => fn(room));
    } catch (err) {
      if (err instanceof GameError && (err.code === "NOT_FOUND" || err.code === "UNAUTHORIZED")) {
        this.failedJoins.record(key);
      }
      throw err;
    }
  }

  /** Attache le client à un salon (en le détachant d'un éventuel salon précédent). */
  private async bind(client: Client, room: Room, enter: () => Promise<Welcome>): Promise<Welcome> {
    if (client.room && client.room !== room) client.room.detach(client.conn.id);
    const welcome = await enter();
    if (this.clients.get(client.conn.id) !== client) {
      // La connexion s'est fermée pendant l'attente : on ne laisse pas de fantôme dans le salon.
      room.detach(client.conn.id);
    } else {
      client.room = room;
    }
    return welcome;
  }

  private guestIdentity(profile: { name: string; avatar?: string | null } | undefined): Identity {
    if (this.options.requireAuth) throw new GameError("UNAUTHORIZED", "Connecte-toi pour jouer.");
    const name = sanitizeDisplayName(profile?.name);
    if (!name) throw new GameError("BAD_REQUEST", "Choisis un pseudo.");
    return {
      provider: "guest",
      externalId: null,
      name,
      avatar: sanitizeAvatar(profile?.avatar ?? null, this.options.avatarPolicy ?? DEFAULT_AVATAR_POLICY),
    };
  }

  // --- Cycle de vie des salons ---------------------------------------------------

  private onIdleChange(room: Room, idle: boolean): void {
    this.cancelDisposal(room.code);
    if (!idle || room.isDisposed) return;
    const handle = this.clock.setTimeout(
      () => {
        this.disposals.delete(room.code);
        if (room.isIdle && this.rooms.get(room.code) === room) this.closeRoom(room.code);
      },
      this.options.emptyRoomTtlMs ?? 10 * 60_000,
    );
    this.disposals.set(room.code, handle);
  }

  private cancelDisposal(code: string): void {
    const handle = this.disposals.get(code);
    if (handle !== undefined) this.clock.clearTimeout(handle);
    this.disposals.delete(code);
  }

  private freeCode(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const code = generateRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    throw new GameError("INTERNAL", INTERNAL_ERROR_MESSAGE);
  }

  // --- Utilitaires -----------------------------------------------------------------

  private ipKey(client: Client): string {
    return client.conn.meta.ip ?? `connexion:${client.conn.id}`;
  }

  private send(client: Client, message: ServerMessage): void {
    try {
      client.conn.send(JSON.stringify(message));
    } catch (err) {
      this.logger.warn("envoi impossible", { connection: client.conn.id, cause: String(err) });
    }
  }

  /** Répond à un message fautif et ferme la connexion si les infractions se répètent. */
  private violation(client: Client, code: GameError["code"], message: string, ref?: number): void {
    this.send(client, { t: "error", ref, code, message });
    const now = this.clock.now();
    client.violations = client.violations.filter((t) => t > now - 60_000);
    client.violations.push(now);
    if (client.violations.length > (this.options.maxViolationsPerMinute ?? 10)) {
      this.logger.warn("connexion fermée après des infractions répétées", {
        connection: client.conn.id,
        ip: client.conn.meta.ip,
      });
      this.disconnect(client.conn.id);
      client.conn.close(POLICY_VIOLATION, "Trop de messages invalides.");
    }
  }
}

/** Récupère l'identifiant de requête d'un message invalide, pour que le client sache lequel a échoué. */
function requestIdOf(json: unknown): number | undefined {
  if (typeof json !== "object" || json === null || !("id" in json)) return undefined;
  const id = json.id;
  return typeof id === "number" && Number.isInteger(id) && id >= 0 && id < 2 ** 31 ? id : undefined;
}
