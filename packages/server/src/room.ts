/**
 * Un salon : ses membres, son host, ses écrans, et la partie en cours.
 *
 * Le salon fait AUTORITÉ : les clients envoient des intentions (« je joue telle carte »),
 * le salon les valide avec le jeu, met à jour l'état, puis envoie à chaque connexion SA
 * vue de la partie (publique, plus privée pour un joueur). Aucune connexion ne reçoit
 * jamais l'état complet.
 *
 * Toutes les modifications d'état sont synchrones (les seules attentes, le hachage des
 * jetons, ont lieu AVANT) : deux messages ne peuvent donc pas s'entrelacer et laisser le
 * salon dans un état incohérent, ce qui garantit le « premier arrivé, premier servi ».
 */

import {
  BOT_PROVIDER,
  GameError,
  applyAction,
  createRng,
  applyPlayerLeave,
  generateToken,
  hashToken,
  parseClientAction,
  resolveSettings,
  setupGame,
  snapshotFor,
  timingSafeEqual,
  uniqueName,
  type BotContext,
  type AnyGame,
  type ByeReason,
  type ClientMessage,
  type Effects,
  type EngineInput,
  type EngineResult,
  type GameEvent,
  type GameSnapshot,
  type IdentityProvider,
  type Limits,
  type LobbyOp,
  type MemberInfo,
  type MemberRole,
  type PlayerInfo,
  type RngState,
  type RoomInfo,
  type RoomStatus,
  type ServerMessage,
  type Viewer,
  type Welcome,
} from "@gamecore/core";
import type { Clock } from "./clock.js";
import type { Connection } from "./connection.js";
import type { Logger } from "./logger.js";
import type { ModuleContext, Recipient, Sender, ServerModule } from "./modules/module.js";

/** Identité d'un membre qui entre, déjà nettoyée et vérifiée par le serveur. */
export interface Identity {
  provider: IdentityProvider;
  /** Identifiant chez le fournisseur (ex. Discord), `null` pour un invité. */
  externalId: string | null;
  name: string;
  avatar: string | null;
}

export interface RoomOptions {
  code: string;
  game: AnyGame;
  settings: unknown;
  rng: RngState;
  /** Hasard propre aux bots (séparé de celui de la partie). */
  botRng?: RngState;
  /** Nombre max de bots par salon. */
  maxBots?: number;
  modules: readonly ServerModule[];
  limits: Limits;
  clock: Clock;
  logger: Logger;
  /** Délai avant de libérer la place d'un membre déconnecté, hors partie. */
  lobbyGraceMs: number;
  allowSpectators: boolean;
  /** Un écran sans jeton d'administration peut-il se brancher (vue publique seulement) ? */
  allowAnonymousScreens: boolean;
  /** Le salon n'a plus (ou de nouveau) aucune connexion. */
  onIdleChange(room: Room, idle: boolean): void;
  /** Le salon détache une connexion de lui-même (expulsion, départ, remplacement, fermeture). */
  onRelease(connectionId: string): void;
}

interface Member {
  id: string;
  name: string;
  avatar: string | null;
  role: MemberRole;
  provider: IdentityProvider;
  externalId: string | null;
  /** Empreinte SHA-256 du jeton de session : le jeton lui-même n'est jamais stocké. */
  tokenHash: string;
  joinedAt: number;
  /** Connexion active, `null` si le membre est déconnecté. */
  connectionId: string | null;
  /** Minuteur de libération de la place après une déconnexion (hors partie). */
  graceTimer: unknown;
  /** Bot géré par le serveur : toujours « connecté », jamais host, sans jeton. */
  bot: boolean;
}

/** Noms des bots quand le jeu n'en propose pas. */
const DEFAULT_BOT_NAMES = [
  "Mamie Ginette",
  "Kévin",
  "Jean-Mi",
  "Samia",
  "Toto",
  "Bernard",
  "Inès",
  "Yanis",
  "Chantal",
  "Hugo",
  "Nadia",
  "Gégé",
];

/** Type d'une action (`action.type` par convention), pour savoir si un coup prévu tient toujours. */
function planKey(action: unknown): string {
  const type =
    typeof action === "object" && action !== null ? (action as { type?: unknown }).type : undefined;
  return typeof type === "string" ? type : JSON.stringify(action);
}

/** Délai par défaut avant qu'un bot joue (ms) : entre 0,8 et 2,5 s. */
const DEFAULT_BOT_DELAY = (random: () => number) => 800 + random() * 1700;

interface Attachment {
  conn: Connection;
  memberId: string | null;
  screen: boolean;
  /** Écran disposant des droits d'host (jeton d'administration valide). */
  admin: boolean;
}

interface RunningGame {
  state: unknown;
  /** Joueurs de la partie, figés au lancement. */
  playerIds: string[];
}

interface Timer {
  at: number;
  action: unknown;
  handle: unknown;
}

const NOT_FOUND_MESSAGE = "Salon introuvable, vérifie le code !";

export class Room {
  readonly code: string;
  readonly game: AnyGame;

  private status_: RoomStatus = "lobby";
  private hostId_: string | null = null;
  private locked = false;
  private settings: unknown;
  private version = 0;
  private rng: RngState;
  private running: RunningGame | null = null;
  private adminTokenHash: string | null = null;
  private disposed = false;

  /** Membres, dans l'ordre d'arrivée. */
  private readonly members = new Map<string, Member>();
  /** Connexions attachées (membres et écrans), par identifiant de connexion. */
  private readonly attachments = new Map<string, Attachment>();
  /** Identités bannies (« fournisseur:identifiant »), pour les comptes vérifiés. */
  private readonly bans = new Set<string>();
  private readonly timers = new Map<string, Timer>();
  private readonly moduleStates = new Map<string, unknown>();
  /** Coup prévu de chaque bot : minuteur et empreinte de l'action prévue. */
  private readonly botTimers = new Map<string, { handle: unknown; plan: string }>();
  private botRng: RngState;

  /** Un changement visible attend d'être diffusé (`commit`). */
  private dirty = false;
  /** Événements du jeu à envoyer après la prochaine diffusion. */
  private outbox: GameEvent[] = [];

  private readonly options: RoomOptions;

  constructor(options: RoomOptions) {
    this.options = options;
    this.code = options.code;
    this.game = options.game;
    this.settings = options.settings;
    this.rng = options.rng;
    this.botRng = options.botRng ?? options.rng;
  }

  // --- Lecture ---------------------------------------------------------------

  get status(): RoomStatus {
    return this.status_;
  }

  get hostId(): string | null {
    return this.hostId_;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Aucune connexion attachée. */
  get isIdle(): boolean {
    return this.attachments.size === 0;
  }

  get connectionCount(): number {
    return this.attachments.size;
  }

  /** État du salon, identique pour tout le monde. */
  info(): RoomInfo {
    return {
      code: this.code,
      status: this.status_,
      hostId: this.hostId_,
      locked: this.locked,
      settings: this.settings,
      members: [...this.members.values()].map((m) => this.memberInfo(m)),
      screens: [...this.attachments.values()].filter((a) => a.screen).length,
      game: {
        id: this.game.id,
        name: this.game.name,
        minPlayers: this.game.minPlayers,
        maxPlayers: this.game.maxPlayers,
      },
      modules: this.options.modules.map((m) => m.name),
    };
  }

  // --- Entrées dans le salon ---------------------------------------------------

  /** Enregistre l'empreinte du jeton d'administration des écrans (à la création). */
  setAdminTokenHash(hash: string): void {
    this.adminTokenHash = hash;
  }

  /**
   * Fait entrer un nouveau membre. S'il s'agit d'un compte vérifié déjà présent (même
   * identifiant Discord, par exemple), il reprend simplement sa place.
   */
  async join(
    conn: Connection,
    identity: Identity,
    options: { spectator?: boolean; host?: boolean } = {},
  ): Promise<Welcome> {
    const token = generateToken();
    const tokenHash = await hashToken(token);
    this.assertAlive();

    if (identity.externalId !== null) {
      if (this.bans.has(`${identity.provider}:${identity.externalId}`)) {
        throw new GameError("FORBIDDEN", "Tu as été expulsé de ce salon.");
      }
      const existing = [...this.members.values()].find(
        (m) => m.provider === identity.provider && m.externalId === identity.externalId,
      );
      if (existing) {
        existing.tokenHash = tokenHash;
        existing.avatar = identity.avatar;
        this.attachMember(conn, existing);
        this.commit();
        this.notifyAttach(conn.id);
        return { code: this.code, kind: existing.role, memberId: existing.id, token };
      }
    }

    if (this.locked && !options.host)
      throw new GameError("ROOM_LOCKED", "Le salon est verrouillé par l'host.");
    if (this.members.size >= this.options.limits.maxMembers)
      throw new GameError("ROOM_FULL", "Le salon est complet.");

    const canPlay = this.status_ !== "playing" && this.playerCount() < this.game.maxPlayers;
    let role: MemberRole;
    if (!options.spectator && canPlay) role = "player";
    else if (this.options.allowSpectators) role = "spectator";
    else if (this.status_ === "playing") throw new GameError("GAME_RUNNING", "La partie a déjà commencé.");
    else throw new GameError("ROOM_FULL", "Il n'y a plus de place dans la partie.");

    const member: Member = {
      id: `m_${generateToken(9)}`,
      name: uniqueName(
        identity.name,
        [...this.members.values()].map((m) => m.name),
      ),
      avatar: identity.avatar,
      role,
      provider: identity.provider,
      externalId: identity.externalId,
      tokenHash,
      joinedAt: this.options.clock.now(),
      connectionId: null,
      graceTimer: null,
      bot: false,
    };
    this.members.set(member.id, member);
    // Le premier membre devient host ; c'est aussi le cas du créateur d'un salon.
    if (this.hostId_ === null || options.host) this.hostId_ = member.id;
    this.attachMember(conn, member);
    this.options.logger.debug("membre entré", { room: this.code, member: member.id, role });
    this.commit();
    this.notifyAttach(conn.id);
    return { code: this.code, kind: role, memberId: member.id, token };
  }

  /** Reprend la place d'un membre grâce à son jeton de session (rechargement, réseau coupé…). */
  async resume(conn: Connection, token: string): Promise<Welcome> {
    const hash = await hashToken(token);
    this.assertAlive();
    const member = [...this.members.values()].find((m) => !m.bot && timingSafeEqual(m.tokenHash, hash));
    if (!member) throw new GameError("UNAUTHORIZED", "Ta session a expiré : rejoins le salon à nouveau.");
    this.attachMember(conn, member);
    this.commit();
    this.notifyAttach(conn.id);
    return { code: this.code, kind: member.role, memberId: member.id };
  }

  /** Branche un écran partagé (vue publique ; droits d'host avec le jeton d'administration). */
  async watch(conn: Connection, adminToken?: string): Promise<Welcome> {
    let admin = false;
    if (adminToken !== undefined) {
      const hash = await hashToken(adminToken);
      admin = this.adminTokenHash !== null && timingSafeEqual(this.adminTokenHash, hash);
      if (!admin) throw new GameError("UNAUTHORIZED", "Jeton d'écran invalide.");
    } else if (!this.options.allowAnonymousScreens) {
      throw new GameError("FORBIDDEN", "Les écrans doivent présenter un jeton d'administration.");
    }
    this.assertAlive();
    const screens = [...this.attachments.values()].filter((a) => a.screen).length;
    if (screens >= this.options.limits.maxScreens)
      throw new GameError("ROOM_FULL", "Trop d'écrans branchés.");

    const wasIdle = this.isIdle;
    this.attachments.set(conn.id, { conn, memberId: null, screen: true, admin });
    this.dirty = true;
    this.commit();
    this.notifyAttach(conn.id);
    if (wasIdle) this.options.onIdleChange(this, false);
    return { code: this.code, kind: "screen", memberId: null };
  }

  // --- Messages d'une connexion attachée -------------------------------------

  /**
   * Traite un message d'une connexion attachée (opération de salon, action de jeu,
   * message d'un module). Renvoie les données de l'accusé de réception.
   */
  handle(connectionId: string, message: ClientMessage): unknown {
    const att = this.attachments.get(connectionId);
    if (!att) throw new GameError("BAD_REQUEST", "Tu n'es dans aucun salon.");
    try {
      switch (message.t) {
        case "leave":
          this.leave(att);
          return undefined;
        case "lobby":
          this.lobby(att, message.op);
          return undefined;
        case "action":
          this.act(att, message.action);
          return undefined;
        case "input":
        case "chat":
          return this.dispatchToModule(att, message);
        default:
          throw new GameError("BAD_REQUEST", "Message inattendu dans un salon.");
      }
    } finally {
      this.commit();
    }
  }

  /** La connexion s'est fermée (réseau, onglet fermé…). Le membre garde sa place un moment. */
  detach(connectionId: string): void {
    const att = this.attachments.get(connectionId);
    if (!att) return;
    this.attachments.delete(connectionId);
    if (att.memberId !== null) {
      const member = this.members.get(att.memberId);
      if (member && member.connectionId === connectionId) {
        member.connectionId = null;
        if (this.status_ !== "playing") this.startGrace(member);
      }
    }
    this.dirty = true;
    this.commit();
    if (this.isIdle) this.options.onIdleChange(this, true);
  }

  /** Ferme le salon : tout le monde est prévenu puis détaché. */
  dispose(reason: ByeReason = "closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.clearBots();
    for (const member of this.members.values()) this.clearGrace(member);
    for (const [id, att] of this.attachments) {
      this.send(att, { t: "bye", reason });
      this.options.onRelease(id);
    }
    this.attachments.clear();
  }

  // --- Opérations de salon -----------------------------------------------------

  private lobby(att: Attachment, op: LobbyOp): void {
    switch (op.op) {
      case "start":
        this.requireHost(att);
        this.start();
        return;

      case "settings": {
        this.requireHost(att);
        if (this.status_ === "playing") {
          throw new GameError("GAME_RUNNING", "Les réglages se changent entre deux parties.");
        }
        const res = resolveSettings(this.game, this.settings, op.settings);
        if (!res.ok) throw res.error;
        this.settings = res.settings;
        this.dirty = true;
        return;
      }

      case "kick": {
        this.requireHost(att);
        const target = this.members.get(op.memberId);
        if (!target) throw new GameError("NOT_FOUND", "Ce membre n'est plus dans le salon.");
        if (target.id === att.memberId)
          throw new GameError("BAD_REQUEST", "Tu ne peux pas t'expulser toi-même.");
        if (target.externalId !== null) this.bans.add(`${target.provider}:${target.externalId}`);
        this.removeMember(target, "kicked");
        return;
      }

      case "promote": {
        this.requireHost(att);
        if (!this.members.has(op.memberId))
          throw new GameError("NOT_FOUND", "Ce membre n'est plus dans le salon.");
        this.hostId_ = op.memberId;
        this.dirty = true;
        return;
      }

      case "role": {
        const member = att.memberId !== null ? this.members.get(att.memberId) : undefined;
        if (!member) throw new GameError("FORBIDDEN", "Un écran n'a pas de rôle.");
        if (this.status_ === "playing") throw new GameError("GAME_RUNNING", "Attends la fin de la partie.");
        if (op.role === member.role) return;
        if (op.role === "player" && this.playerCount() >= this.game.maxPlayers) {
          throw new GameError("ROOM_FULL", "Plus de place parmi les joueurs.");
        }
        if (op.role === "spectator" && !this.options.allowSpectators) {
          throw new GameError("FORBIDDEN", "Ce jeu n'accepte pas de spectateurs.");
        }
        member.role = op.role;
        this.dirty = true;
        return;
      }

      case "lock":
        this.requireHost(att);
        this.locked = op.locked;
        this.dirty = true;
        return;

      case "end":
        this.requireHost(att);
        if (this.status_ === "lobby") throw new GameError("BAD_REQUEST", "Aucune partie à arrêter.");
        this.backToLobby();
        return;

      case "addBot":
        this.requireHost(att);
        this.addBot();
        return;
    }
  }

  /** Ajoute un bot joueur (il se retire comme n'importe qui : `kick`). */
  private addBot(): void {
    const strategy = this.game.bots;
    if (!strategy) throw new GameError("MODULE_DISABLED", "Ce jeu ne propose pas de bots.");
    if (this.status_ === "playing")
      throw new GameError("GAME_RUNNING", "Ajoute les bots entre deux parties.");
    const bots = [...this.members.values()].filter((m) => m.bot);
    if (bots.length >= (this.options.maxBots ?? 8))
      throw new GameError("ROOM_FULL", "Il y a déjà assez de bots.");
    if (this.playerCount() >= this.game.maxPlayers || this.members.size >= this.options.limits.maxMembers) {
      throw new GameError("ROOM_FULL", "Plus de place parmi les joueurs.");
    }
    const taken = [...this.members.values()].map((m) => m.name);
    const names = strategy.names?.length ? strategy.names : DEFAULT_BOT_NAMES;
    const free = names.find((n) => !taken.includes(n)) ?? names[bots.length % names.length]!;
    const member: Member = {
      id: `b_${generateToken(9)}`,
      name: uniqueName(free, taken),
      avatar: "🤖",
      role: "player",
      provider: BOT_PROVIDER,
      externalId: null,
      tokenHash: "",
      joinedAt: this.options.clock.now(),
      connectionId: null,
      graceTimer: null,
      bot: true,
    };
    this.members.set(member.id, member);
    this.dirty = true;
  }

  /** Lance une partie (ou une revanche) avec les joueurs présents. */
  private start(): void {
    if (this.status_ === "playing") throw new GameError("GAME_RUNNING", "La partie a déjà commencé.");
    const players = [...this.members.values()].filter((m) => m.role === "player");
    if (players.length < this.game.minPlayers) {
      throw new GameError("RULE", `Il faut au moins ${this.game.minPlayers} joueurs pour lancer la partie.`);
    }
    if (players.length > this.game.maxPlayers) {
      throw new GameError("RULE", `${this.game.maxPlayers} joueurs maximum : passe quelqu'un en spectateur.`);
    }
    this.clearTimers();
    this.clearBots();
    for (const p of players) this.clearGrace(p);
    const playerIds = players.map((p) => p.id);
    const res = setupGame(this.game, this.engineInput(playerIds));
    if (!res.ok) this.fail(res, "setup");
    this.running = { state: res.state, playerIds };
    this.status_ = "playing";
    this.rng = res.rng;
    this.dirty = true;
    this.options.logger.info("partie lancée", { room: this.code, players: playerIds.length });
    this.applyEffects(res.effects);
    this.checkOver();
  }

  private backToLobby(): void {
    this.clearTimers();
    this.clearBots();
    this.running = null;
    this.status_ = "lobby";
    for (const m of this.members.values()) if (m.connectionId === null && !m.bot) this.startGrace(m);
    this.dirty = true;
  }

  private leave(att: Attachment): void {
    if (att.screen) {
      this.attachments.delete(att.conn.id);
      this.send(att, { t: "bye", reason: "left" });
      this.options.onRelease(att.conn.id);
      this.dirty = true;
      if (this.isIdle) this.options.onIdleChange(this, true);
      return;
    }
    const member = att.memberId !== null ? this.members.get(att.memberId) : undefined;
    if (member) this.removeMember(member, "left");
  }

  // --- Partie --------------------------------------------------------------------

  private act(att: Attachment, raw: unknown): void {
    if (this.status_ !== "playing" || !this.running)
      throw new GameError("NOT_PLAYING", "Aucune partie en cours.");
    const viewer = this.viewerOf(att);
    if (viewer.kind !== "player" && !viewer.isHost) {
      throw new GameError("FORBIDDEN", "Seuls les joueurs peuvent agir dans la partie.");
    }
    const parsed = parseClientAction(this.game, raw);
    if (!parsed.ok) throw parsed.error;
    const running = this.running;
    const res = applyAction(
      this.game,
      running.state,
      parsed.action,
      viewer,
      this.engineInput(running.playerIds),
    );
    this.commitGame(res, "action");
  }

  /** Déclenche une action système programmée par le jeu. */
  private fireTimer(key: string): void {
    const timer = this.timers.get(key);
    this.timers.delete(key);
    if (!timer || this.disposed || this.status_ !== "playing" || !this.running) return;
    if (this.game.systemActions && !this.game.systemActions.safeParse(timer.action).success) {
      this.options.logger.error("action système invalide ignorée", { room: this.code, key });
      return;
    }
    const running = this.running;
    // Appelé par un minuteur : aucune exception ne doit remonter (elle ferait tomber le processus).
    try {
      const res = applyAction(
        this.game,
        running.state,
        timer.action,
        { kind: "system" },
        this.engineInput(running.playerIds),
      );
      this.commitGame(res, "timer");
    } catch (err) {
      if (err instanceof GameError && err.code !== "INTERNAL") {
        // Refus d'une action système (« trop tard ») : comportement normal, rien à signaler.
        this.options.logger.debug("action système refusée", { room: this.code, key, reason: err.message });
      } else if (!(err instanceof GameError)) {
        this.options.logger.error("erreur au déclenchement d'un minuteur", {
          room: this.code,
          key,
          cause: String(err),
        });
      }
    } finally {
      this.commit();
    }
  }

  /** Enregistre le résultat d'un appel au jeu, ou lève son erreur. */
  private commitGame(res: EngineResult<unknown>, origin: string): void {
    if (!res.ok) this.fail(res, origin);
    if (!this.running) return;
    this.running.state = res.state;
    this.rng = res.rng;
    this.dirty = true;
    this.applyEffects(res.effects);
    this.checkOver();
  }

  private fail(res: Extract<EngineResult<unknown>, { ok: false }>, origin: string): never {
    if (res.error.code === "INTERNAL") {
      // Le détail reste dans les journaux du serveur ; le client ne reçoit qu'un message générique.
      this.options.logger.error("erreur dans le code du jeu", {
        room: this.code,
        game: this.game.id,
        origin,
        cause: res.cause instanceof Error ? (res.cause.stack ?? res.cause.message) : String(res.cause),
      });
    }
    throw res.error;
  }

  private checkOver(): void {
    if (this.running && this.game.isOver?.(this.running.state)) {
      this.status_ = "finished";
      this.clearTimers();
      this.clearBots();
      this.options.logger.info("partie terminée", { room: this.code });
    }
  }

  private applyEffects(effects: Effects): void {
    for (const timer of effects.timers) {
      const existing = this.timers.get(timer.key);
      if (existing) this.options.clock.clearTimeout(existing.handle);
      this.timers.delete(timer.key);
      if (timer.op === "set") {
        const delay = timer.at - this.options.clock.now();
        const handle = this.options.clock.setTimeout(() => this.fireTimer(timer.key), delay);
        this.timers.set(timer.key, { at: timer.at, action: timer.action, handle });
      }
    }
    this.outbox.push(...effects.events);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) this.options.clock.clearTimeout(timer.handle);
    this.timers.clear();
  }

  private engineInput(playerIds: readonly string[]): EngineInput {
    return {
      players: this.playersOf(playerIds),
      settings: this.settings,
      now: this.options.clock.now(),
      rng: this.rng,
    };
  }

  private playersOf(playerIds: readonly string[]): PlayerInfo[] {
    const players: PlayerInfo[] = [];
    for (const id of playerIds) {
      const m = this.members.get(id);
      if (m)
        players.push({
          id: m.id,
          name: m.name,
          avatar: m.avatar,
          connected: m.bot || m.connectionId !== null,
        });
    }
    return players;
  }

  // --- Bots ------------------------------------------------------------------------

  /**
   * Planifie le prochain coup de chaque bot de la partie. Appelé après chaque changement.
   * Un coup prévu garde son minuteur tant que le bot veut jouer le même TYPE d'action (sinon
   * un bot qui tire ses coups au hasard serait sans cesse repoussé par les coups des
   * autres) ; le coup exact est recalculé au moment de jouer.
   */
  private scheduleBots(): void {
    const running = this.running;
    if (!this.game.bots || !running || this.status_ !== "playing" || this.disposed) {
      this.clearBots();
      return;
    }
    for (const botId of running.playerIds) {
      const member = this.members.get(botId);
      if (!member?.bot) continue;
      const action = this.botDecision(botId);
      const current = this.botTimers.get(botId);
      if (action === null) {
        if (current) this.options.clock.clearTimeout(current.handle);
        this.botTimers.delete(botId);
        continue;
      }
      const plan = planKey(action);
      if (current?.plan === plan) continue;
      if (current) this.options.clock.clearTimeout(current.handle);
      const ctx = this.botContext(botId);
      const delay = this.game.bots.delay?.(action, ctx) ?? DEFAULT_BOT_DELAY(() => ctx.random.next());
      this.botRng = ctx.random.state();
      const handle = this.options.clock.setTimeout(() => this.fireBot(botId), Math.max(0, delay));
      this.botTimers.set(botId, { handle, plan });
    }
  }

  /** Le bot joue : son coup est recalculé (la partie a pu avancer) puis validé comme celui d'un humain. */
  private fireBot(botId: string): void {
    this.botTimers.delete(botId);
    const running = this.running;
    if (!running || this.status_ !== "playing" || this.disposed || !this.members.get(botId)?.bot) return;
    try {
      const action = this.botDecision(botId);
      if (action === null) return;
      const parsed = parseClientAction(this.game, action);
      if (!parsed.ok) {
        this.options.logger.error("coup de bot hors du schéma des actions", {
          room: this.code,
          game: this.game.id,
        });
        return;
      }
      const actor = { kind: "player" as const, id: botId, isHost: false };
      const res = applyAction(
        this.game,
        running.state,
        parsed.action,
        actor,
        this.engineInput(running.playerIds),
      );
      this.commitGame(res, "bot");
    } catch (err) {
      // Un coup refusé (« trop tard ») est normal ; une erreur du jeu est déjà journalisée.
      if (!(err instanceof GameError)) {
        this.options.logger.error("erreur au tour d'un bot", { room: this.code, cause: String(err) });
      }
    } finally {
      this.commit();
    }
  }

  /** Ce que ferait ce bot maintenant (`null` en cas d'erreur dans la stratégie du jeu). */
  private botDecision(botId: string): unknown {
    const running = this.running;
    const strategy = this.game.bots;
    if (!running || !strategy) return null;
    const viewer = { kind: "player" as const, id: botId, isHost: false };
    const ctx = this.botContext(botId);
    try {
      const viewCtx = { now: ctx.now, settings: this.settings, players: ctx.players };
      const view = snapshotFor(this.game, running.state, viewer, viewCtx);
      const action = strategy.decide(view, running.state, ctx) as unknown;
      this.botRng = ctx.random.state();
      return action ?? null;
    } catch (err) {
      this.options.logger.error("erreur dans la stratégie des bots", { room: this.code, cause: String(err) });
      return null;
    }
  }

  private botContext(botId: string): BotContext<unknown> {
    return {
      botId,
      now: this.options.clock.now(),
      random: createRng(this.botRng),
      settings: this.settings,
      players: this.playersOf(this.running?.playerIds ?? []),
    };
  }

  private clearBots(): void {
    for (const { handle } of this.botTimers.values()) this.options.clock.clearTimeout(handle);
    this.botTimers.clear();
  }

  // --- Membres ---------------------------------------------------------------------

  private attachMember(conn: Connection, member: Member): void {
    // Une seule connexion par membre : l'ancienne (autre onglet, connexion fantôme) est remplacée.
    if (member.connectionId !== null && member.connectionId !== conn.id) {
      const previous = this.attachments.get(member.connectionId);
      if (previous) {
        this.attachments.delete(member.connectionId);
        this.send(previous, { t: "bye", reason: "replaced" });
        this.options.onRelease(member.connectionId);
      }
    }
    const wasIdle = this.isIdle;
    this.clearGrace(member);
    member.connectionId = conn.id;
    this.attachments.set(conn.id, { conn, memberId: member.id, screen: false, admin: false });
    this.dirty = true;
    if (wasIdle) this.options.onIdleChange(this, false);
  }

  private removeMember(member: Member, reason: "left" | "kicked" | "timeout"): void {
    this.members.delete(member.id);
    this.clearGrace(member);
    if (member.connectionId !== null) {
      const att = this.attachments.get(member.connectionId);
      this.attachments.delete(member.connectionId);
      if (att) {
        if (reason !== "timeout") this.send(att, { t: "bye", reason });
        this.options.onRelease(member.connectionId);
      }
    }
    const running = this.running;
    if (running && running.playerIds.includes(member.id)) {
      running.playerIds = running.playerIds.filter((id) => id !== member.id);
      try {
        const res = applyPlayerLeave(
          this.game,
          running.state,
          member.id,
          this.engineInput(running.playerIds),
        );
        this.commitGame(res, "leave");
      } catch (err) {
        // Le départ doit aboutir même si le jeu gère mal ce cas (erreur déjà journalisée).
        if (!(err instanceof GameError)) throw err;
      }
      if (running.playerIds.length === 0 && this.status_ === "playing") this.backToLobby();
    }
    if (this.hostId_ === member.id) this.hostId_ = this.pickNewHost();
    for (const module of this.options.modules) module.onMemberLeave?.(this.moduleContext(module), member.id);
    this.options.logger.debug("membre parti", { room: this.code, member: member.id, reason });
    this.dirty = true;
    if (this.isIdle) this.options.onIdleChange(this, true);
  }

  /** Nouvel host : le plus ancien joueur connecté, à défaut le plus ancien membre connecté. */
  private pickNewHost(): string | null {
    // Un bot n'est jamais host : sans humain, le salon n'a plus d'host.
    const all = [...this.members.values()].filter((m) => !m.bot);
    const connected = all.filter((m) => m.connectionId !== null);
    return (connected.find((m) => m.role === "player") ?? connected[0] ?? all[0])?.id ?? null;
  }

  private startGrace(member: Member): void {
    this.clearGrace(member);
    member.graceTimer = this.options.clock.setTimeout(() => {
      member.graceTimer = null;
      if (this.disposed || member.connectionId !== null || this.status_ === "playing") return;
      if (!this.members.has(member.id)) return;
      this.removeMember(member, "timeout");
      this.commit();
    }, this.options.lobbyGraceMs);
  }

  private clearGrace(member: Member): void {
    if (member.graceTimer !== null) this.options.clock.clearTimeout(member.graceTimer);
    member.graceTimer = null;
  }

  private playerCount(): number {
    let count = 0;
    for (const m of this.members.values()) if (m.role === "player") count++;
    return count;
  }

  private memberInfo(m: Member): MemberInfo {
    return {
      id: m.id,
      name: m.name,
      avatar: m.avatar,
      role: m.role,
      connected: m.bot || m.connectionId !== null,
      isHost: m.id === this.hostId_,
      provider: m.provider,
    };
  }

  private viewerOf(att: Attachment): Viewer {
    if (att.screen || att.memberId === null) return { kind: "screen", isHost: att.admin };
    const m = this.members.get(att.memberId);
    const isHost = att.memberId === this.hostId_;
    if (m?.role === "player") return { kind: "player", id: att.memberId, isHost };
    return { kind: "spectator", id: att.memberId, isHost };
  }

  private requireHost(att: Attachment): void {
    if (!this.viewerOf(att).isHost) throw new GameError("FORBIDDEN", "Réservé à l'host du salon.");
  }

  private assertAlive(): void {
    if (this.disposed) throw new GameError("NOT_FOUND", NOT_FOUND_MESSAGE);
  }

  // --- Modules -----------------------------------------------------------------------

  private dispatchToModule(att: Attachment, message: ClientMessage): unknown {
    const module = this.options.modules.find((m) => m.handles?.includes(message.t));
    if (!module?.handle) throw new GameError("MODULE_DISABLED", "Cette fonctionnalité n'est pas activée.");
    const member = att.memberId !== null ? this.members.get(att.memberId) : undefined;
    const sender: Sender = {
      connectionId: att.conn.id,
      viewer: this.viewerOf(att),
      memberId: att.memberId,
      member: member ? this.memberInfo(member) : null,
    };
    return module.handle(this.moduleContext(module), sender, message);
  }

  private moduleContext(module: ServerModule): ModuleContext {
    return {
      code: this.code,
      status: this.status_,
      hostId: this.hostId_,
      logger: this.options.logger,
      now: () => this.options.clock.now(),
      members: () => [...this.members.values()].map((m) => this.memberInfo(m)),
      playerIds: () => this.running?.playerIds ?? [],
      gameState: () => this.running?.state ?? null,
      send: (filter, message) => {
        for (const att of this.attachments.values()) {
          if (filter(this.recipientOf(att))) this.send(att, message);
        }
      },
      sendTo: (connectionId, message) => {
        const att = this.attachments.get(connectionId);
        if (att) this.send(att, message);
      },
      state: <T>(init: () => T): T => {
        if (!this.moduleStates.has(module.name)) this.moduleStates.set(module.name, init());
        return this.moduleStates.get(module.name) as T;
      },
    };
  }

  /** Laisse les modules accueillir une connexion (ex. historique du chat), après la synchronisation. */
  private notifyAttach(connectionId: string): void {
    const att = this.attachments.get(connectionId);
    if (!att || this.disposed) return;
    for (const module of this.options.modules) {
      module.onAttach?.(this.moduleContext(module), this.recipientOf(att));
    }
  }

  private recipientOf(att: Attachment): Recipient {
    return { connectionId: att.conn.id, viewer: this.viewerOf(att), memberId: att.memberId };
  }

  // --- Diffusion ---------------------------------------------------------------------

  /**
   * Diffuse l'état à chaque connexion si quelque chose a changé, puis les événements du jeu.
   * Chaque destinataire reçoit SA vue : publique pour tous, privée pour un joueur.
   */
  private commit(): void {
    if (this.dirty) {
      this.dirty = false;
      this.version++;
      this.scheduleBots();
      const room = this.info();
      const viewCtx = { now: this.options.clock.now(), settings: this.settings, players: [] as PlayerInfo[] };
      let publicView: unknown;
      let viewsFailed = false;
      if (this.running) {
        viewCtx.players = this.playersOf(this.running.playerIds);
        try {
          publicView = this.game.views.public(this.running.state, viewCtx);
        } catch (err) {
          viewsFailed = true;
          this.options.logger.error("erreur dans la vue publique du jeu", {
            room: this.code,
            cause: String(err),
          });
        }
      }
      for (const att of this.attachments.values()) {
        const viewer = this.viewerOf(att);
        let game: GameSnapshot | null = null;
        if (this.running && !viewsFailed) {
          try {
            game = snapshotFor(this.game, this.running.state, viewer, viewCtx, publicView);
          } catch (err) {
            this.options.logger.error("erreur dans la vue privée du jeu", {
              room: this.code,
              cause: String(err),
            });
          }
        }
        this.send(att, {
          t: "sync",
          version: this.version,
          room,
          you: { kind: viewer.kind, id: viewer.kind === "screen" ? null : viewer.id, isHost: viewer.isHost },
          game,
        });
      }
    }
    if (this.outbox.length > 0) {
      const events = this.outbox;
      this.outbox = [];
      for (const event of events) this.deliver(event);
    }
  }

  private deliver(event: GameEvent): void {
    const message: ServerMessage = { t: "event", name: event.name, data: event.data };
    const players = new Set(this.running?.playerIds ?? []);
    for (const att of this.attachments.values()) {
      const to = event.to;
      const ok =
        to === "all" ||
        (to === "screens" && att.screen) ||
        (to === "players" && att.memberId !== null && players.has(att.memberId)) ||
        (typeof to === "object" && att.memberId !== null && to.only.includes(att.memberId));
      if (ok) this.send(att, message);
    }
  }

  private send(att: Attachment, message: ServerMessage): void {
    try {
      att.conn.send(JSON.stringify(message));
    } catch (err) {
      this.options.logger.warn("envoi impossible", {
        room: this.code,
        connection: att.conn.id,
        cause: String(err),
      });
    }
  }
}
