/**
 * Hôte en mémoire d'une simulation (`createSimulation`).
 *
 * Déroulé d'un tick (toujours complet, jamais sauté) :
 *   1. commandes de l'hôte en file, dans l'ordre d'arrivée (validate → apply → journal) ;
 *   2. commandes système échues, dans l'ordre où elles ont été programmées ;
 *   3. systèmes, dans l'ordre déclaré (ceux qui ont `every` seulement quand c'est leur tour) ;
 *   4. canaux échus (`every`) marqués à republier.
 *
 * La boucle de tick n'alloue rien d'évitable : contextes créés une fois et réutilisés, file
 * vidée en place, temps mesurés dans des Float64Array. L'état n'est jamais copié. Seuls les
 * événements émis et les entrées du journal créent des objets (ce sont des données voulues).
 */

import { GameError, createRng, randomSeed, type ErrorCode, type Rng, type RngState } from "@gamecore/core";
import type {
  AnySimulation,
  ChannelDefinition,
  CommandContext,
  CommandOrigin,
  SimContext,
  SimProfileView,
  SimTypes,
  SnapshotContext,
  ValidateContext,
} from "./definition.js";
import { hashState } from "./hash.js";

export interface SimOptions<Settings = unknown> {
  /** Graine du hasard (aléatoire par défaut). Même graine + même journal = même partie. */
  seed?: string;
  /** Réglages (fusionnés avec les valeurs par défaut, validés par le schéma). */
  settings?: Partial<Settings>;
  /** Ne garder dans le journal que les commandes des `journalRetention` derniers ticks. */
  journalRetention?: number;
  /** Commandes en attente max avant refus (10 000 par défaut). */
  maxQueuedCommands?: number;
  /** Événements gardés entre deux `drain` (10 000 par défaut ; au-delà, les plus anciens tombent). */
  maxBufferedEvents?: number;
  /** Horloge du profilage, en ms (par défaut `performance.now`). N'influence jamais la simulation. */
  clock?: () => number;
  /** Mesurer les temps de chaque système (oui par défaut). */
  profile?: boolean;
}

export interface JournalEntry<Command = unknown> {
  /** Tick pendant lequel la commande a été appliquée. */
  readonly tick: number;
  readonly seq: number;
  readonly command: Command;
}

export interface SimEvent {
  readonly name: string;
  readonly data: unknown;
  /** Tick pendant lequel l'événement a été émis (0 : dans `create`). */
  readonly tick: number;
}

/** Données de l'événement `commandRejected`. */
export interface CommandRejection {
  /** Numéro renvoyé par `dispatch` (`null` pour une commande système). */
  readonly seq: number | null;
  /** Clé de la commande système (`null` pour une commande de l'hôte). */
  readonly key: string | null;
  readonly origin: CommandOrigin;
  readonly message: string;
}

/** Données de l'événement `corrupted` (et de `sim.corrupted`). */
export interface CorruptionInfo {
  /** Tick pendant lequel l'exception s'est produite. */
  readonly tick: number;
  /** Système fautif, ou `apply(<type>)` pour une commande. */
  readonly system: string;
  /** Message de l'exception. */
  readonly cause: string;
}

export type DispatchResult = { ok: true; seq: number } | { ok: false; error: GameError };

export interface SimSnapshot<Full = unknown> {
  tick: number;
  full: Full;
  channels: Record<string, unknown>;
}

export interface DrainPayload {
  tick: number;
  /** Canaux invalidés ou échus depuis le dernier `drain`. */
  channels: Record<string, unknown>;
  events: SimEvent[];
  /** Événements perdus faute de `drain` (tampon plein). */
  droppedEvents: number;
}

export interface ScheduledCommand<SystemCommand = unknown> {
  readonly key: string;
  /** Tick pendant lequel elle s'exécutera. */
  readonly due: number;
  readonly command: SystemCommand;
}

export interface SimProfile {
  tickMs: { last: number; avg: number };
  systems: Record<string, { last: number; avg: number; runs: number }>;
}

/** Ce que voit l'hôte d'une simulation en mémoire. */
export interface Sim<D extends AnySimulation = AnySimulation> {
  readonly definition: D;
  /** Ticks terminés. */
  readonly tick: number;
  /** État vivant (réservé aux tests, aux bots et aux outils : ne pas le modifier). */
  readonly state: SimTypes<D>["state"];
  /** Réglages résolus (gelés). */
  readonly settings: SimTypes<D>["settings"];
  /** Graine d'origine (`null` si inconnue). */
  readonly seed: string | null;
  /** Journal des commandes de l'hôte acceptées (lecture seule). */
  readonly journal: readonly JournalEntry<SimTypes<D>["command"]>[];
  /**
   * Premier tick dont le journal est complet : 0 tant que rien n'a été écarté (la partie est
   * alors rejouable depuis la graine).
   */
  readonly journalFrom: number;
  /** `null`, ou la cause de la corruption (la simulation est alors en lecture seule). */
  readonly corrupted: CorruptionInfo | null;
  /** Met une commande en file (appliquée au début du prochain tick). */
  dispatch(command: unknown): DispatchResult;
  /** Exécute `ticks` ticks (1 par défaut) ; renvoie le nombre réellement exécuté. */
  step(ticks?: number): number;
  /** Snapshot complet (pour (re)démarrer une interface) et tous les canaux. */
  snapshot(): SimSnapshot<SimTypes<D>["full"]>;
  /** Canaux à republier et événements depuis le dernier appel. */
  drain(): DrainPayload;
  /** Hash de la simulation : tick, RNG, état, commandes programmées. */
  hash(): string;
  /** Temps mesurés (copie). */
  profile(): SimProfile;
  /** Commandes système programmées, dans l'ordre d'exécution à échéance égale (copie). */
  scheduled(): ScheduledCommand<SimTypes<D>["systemCommand"]>[];
  /** État courant du générateur aléatoire. */
  rngState(): RngState;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function defaultClock(): () => number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  // Sans `performance` (cas marginal), le profilage affiche 0 : jamais d'horloge murale ici.
  return perf ? () => perf.now() : () => 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Résout des réglages : valeurs par défaut + surcharge, validées par le schéma, puis gelées. */
export function resolveSimSettings<D extends AnySimulation>(
  definition: D,
  settings: unknown,
): SimTypes<D>["settings"] {
  const defaults = definition.settings.defaults as unknown;
  const merged =
    typeof settings === "object" && settings !== null && typeof defaults === "object" && defaults !== null
      ? { ...defaults, ...settings }
      : (settings ?? defaults);
  const parsed = definition.settings.schema.safeParse(merged);
  if (!parsed.success) throw new GameError("BAD_REQUEST", "Réglages de simulation invalides.");
  // Gelés : un système qui les modifierait casserait le rejeu (ils sont sauvegardés à part).
  return deepFreeze(parsed.data) as SimTypes<D>["settings"];
}

/** @internal Implémentation ; les hôtes n'en voient que l'interface `Sim`. */
export class SimImpl<D extends AnySimulation> implements Sim<D> {
  readonly definition: D;
  readonly settings: SimTypes<D>["settings"];
  readonly seed: string | null;

  state!: SimTypes<D>["state"];
  journal: JournalEntry<SimTypes<D>["command"]>[] = [];
  journalFrom = 0;
  corrupted: CorruptionInfo | null = null;

  /** Ticks terminés. */
  protected ticks = 0;
  /** Tick en cours d'exécution (= `ticks` hors d'un tick, 0 pendant `create`). */
  protected current = 0;
  protected seq = 0;
  protected readonly rng: Rng;
  private readonly retention: number | null;
  private readonly maxQueued: number;
  private readonly maxEvents: number;
  private readonly profiling: boolean;
  private readonly clock: () => number;

  // File des commandes de l'hôte, vidée en place à chaque tick.
  private readonly queue: { seq: number; command: unknown }[] = [];
  // Commandes système programmées, dans l'ordre de programmation (tableaux parallèles).
  protected readonly schedKeys: string[] = [];
  protected readonly schedDue: number[] = [];
  protected readonly schedCommands: unknown[] = [];
  /** Borne inférieure des échéances : évite de parcourir la liste quand rien n'est dû. */
  private minDue = Infinity;

  private readonly channelNames: string[];
  private readonly channelDefs: ChannelDefinition<unknown, unknown>[];
  private readonly channelIndex = new Map<string, number>();
  private readonly pending: Uint8Array;

  // Tampon d'événements : les plus anciens sont écartés en avançant `eventsStart` (O(1)).
  private events: SimEvent[] = [];
  private eventsStart = 0;
  private droppedEvents = 0;

  // Profilage : derniers temps et moyennes glissantes, sans allocation.
  private readonly sysLast: Float64Array;
  private readonly sysAvg: Float64Array;
  private readonly sysRuns: Float64Array;
  private readonly tickTimes = new Float64Array(2); // [dernier, moyenne]

  // Contextes réutilisés (jamais recréés pendant un tick).
  private readonly ctx: SimContext<unknown, unknown>;
  private readonly commandCtx: CommandContext<unknown, unknown> & { origin: CommandOrigin };
  private readonly validateCtx: { tick: number; settings: unknown; origin: CommandOrigin };
  private readonly snapshotCtx: SnapshotContext<unknown>;

  constructor(
    definition: D,
    settings: SimTypes<D>["settings"],
    seed: string | null,
    rng: Rng,
    options: SimOptions,
  ) {
    this.definition = definition;
    this.settings = settings;
    this.seed = seed;
    this.rng = rng;
    this.retention = options.journalRetention ?? null;
    if (this.retention !== null && !(Number.isInteger(this.retention) && this.retention >= 1)) {
      throw new RangeError("journalRetention : entier ≥ 1 attendu.");
    }
    this.maxQueued = options.maxQueuedCommands ?? 10_000;
    this.maxEvents = options.maxBufferedEvents ?? 10_000;
    this.profiling = options.profile ?? true;
    this.clock = options.clock ?? defaultClock();

    const channels = (definition.snapshot.channels ?? {}) as Record<
      string,
      ChannelDefinition<unknown, unknown>
    >;
    this.channelNames = Object.keys(channels);
    this.channelDefs = this.channelNames.map((name) => channels[name]!);
    this.channelNames.forEach((name, i) => this.channelIndex.set(name, i));
    this.pending = new Uint8Array(this.channelNames.length);

    const systemCount = definition.systems.length;
    this.sysLast = new Float64Array(systemCount);
    this.sysAvg = new Float64Array(systemCount);
    this.sysRuns = new Float64Array(systemCount);

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- accesseurs des contextes
    const self = this;
    this.ctx = {
      get tick() {
        return self.current;
      },
      random: rng,
      settings,
      emit: (name, data) => self.pushEvent(name, data),
      schedule: (key, delay, command) => self.scheduleCommand(key, delay, command),
      cancel: (key) => self.cancelCommand(key),
      invalidate: (channel) => self.invalidate(channel),
      profile: this.profiling ? this.makeProfileView() : null,
    };
    // Même contexte, plus la provenance de la commande (propriété propre, modifiée en place).
    const origin: { origin: CommandOrigin } = { origin: "host" };
    this.commandCtx = Object.assign(Object.create(this.ctx) as SimContext<unknown, unknown>, origin);
    this.validateCtx = { tick: 0, settings, origin: "host" };
    this.snapshotCtx = {
      get tick() {
        return self.ticks;
      },
      settings,
    };
  }

  /** Crée l'état initial (tick 0). */
  init(): this {
    this.current = 0;
    this.state = this.definition.create(this.ctx) as SimTypes<D>["state"];
    return this;
  }

  // --- Lecture ------------------------------------------------------------------------

  get tick(): number {
    return this.ticks;
  }

  rngState(): RngState {
    return this.rng.state();
  }

  scheduled(): ScheduledCommand<SimTypes<D>["systemCommand"]>[] {
    return this.schedKeys.map((key, i) => ({
      key,
      due: this.schedDue[i]!,
      command: this.schedCommands[i],
    }));
  }

  hash(): string {
    const def = this.definition;
    const stateHash = def.hash ? def.hash(this.state) : hashState(this.state);
    return hashState([
      this.ticks,
      this.rng.state(),
      stateHash,
      this.schedKeys,
      this.schedDue,
      this.schedCommands,
    ]);
  }

  profile(): SimProfile {
    const systems: SimProfile["systems"] = {};
    this.definition.systems.forEach((s, i) => {
      systems[s.name] = { last: this.sysLast[i]!, avg: this.sysAvg[i]!, runs: this.sysRuns[i]! };
    });
    return { tickMs: { last: this.tickTimes[0]!, avg: this.tickTimes[1]! }, systems };
  }

  // --- Commandes ----------------------------------------------------------------------

  dispatch(command: unknown): DispatchResult {
    const fail = (code: ErrorCode, text: string): DispatchResult => ({
      ok: false,
      error: new GameError(code, text),
    });
    if (this.corrupted) return fail("INTERNAL", "Simulation corrompue : elle est en lecture seule.");
    if (this.queue.length >= this.maxQueued) return fail("RATE_LIMITED", "Trop de commandes en attente.");
    const parsed = this.definition.commands.safeParse(command);
    if (!parsed.success) {
      // Une commande système ne vient jamais de l'hôte : refus explicite, avant toute validation.
      if (this.definition.systemCommands?.safeParse(command).success) {
        return fail("FORBIDDEN", "Commande réservée à la simulation.");
      }
      return fail("BAD_REQUEST", "Commande invalide.");
    }
    const seq = ++this.seq;
    this.queue.push({ seq, command: parsed.data });
    return { ok: true, seq };
  }

  // --- Boucle de tick -------------------------------------------------------------------

  step(ticks = 1): number {
    if (!Number.isInteger(ticks) || ticks < 0) throw new RangeError(`Nombre de ticks invalide : ${ticks}`);
    let done = 0;
    while (done < ticks && this.corrupted === null) {
      if (this.runTick()) done++;
    }
    return done;
  }

  /** Exécute un tick ; `false` si la simulation s'est corrompue pendant ce tick. */
  private runTick(): boolean {
    const profiling = this.profiling;
    const t = this.ticks + 1;
    this.current = t;
    this.validateCtx.tick = t;
    const tickStart = profiling ? this.clock() : 0;

    // 1. Commandes de l'hôte, dans l'ordre d'arrivée.
    const queue = this.queue;
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i]!;
      if (!this.applyCommand(entry.command, "host", entry.seq, null)) return false;
    }
    queue.length = 0;

    // 2. Commandes système échues (celles programmées pendant ce tick sont pour plus tard).
    if (t >= this.minDue) {
      for (let i = this.firstDue(t); i >= 0; i = this.firstDue(t)) {
        const key = this.schedKeys[i]!;
        const command = this.schedCommands[i];
        this.removeScheduled(i);
        if (!this.applyCommand(command, "system", null, key)) return false;
      }
      this.minDue = Infinity;
      for (const due of this.schedDue) if (due < this.minDue) this.minDue = due;
    }

    // 3. Systèmes, dans l'ordre déclaré.
    const systems = this.definition.systems;
    for (let s = 0; s < systems.length; s++) {
      const system = systems[s]!;
      if (system.every !== undefined && t % system.every !== 0) continue;
      const start = profiling ? this.clock() : 0;
      try {
        system.update(this.state, this.ctx);
      } catch (err) {
        this.corrupt(system.name, err);
        return false;
      }
      if (profiling) this.record(s, this.clock() - start);
    }

    // 4. Canaux échus.
    const defs = this.channelDefs;
    for (let c = 0; c < defs.length; c++) {
      const every = defs[c]!.every;
      if (every !== undefined && t % every === 0) this.pending[c] = 1;
    }

    this.ticks = t;
    if (this.retention !== null) this.trimJournal(t, this.retention);
    if (profiling) {
      const elapsed = this.clock() - tickStart;
      this.tickTimes[0] = elapsed;
      this.tickTimes[1] = t === 1 ? elapsed : this.tickTimes[1]! * 0.9 + elapsed * 0.1;
    }
    return true;
  }

  /** Valide puis applique une commande ; `false` si la simulation s'est corrompue. */
  private applyCommand(
    command: unknown,
    origin: CommandOrigin,
    seq: number | null,
    key: string | null,
  ): boolean {
    const def = this.definition;
    if (def.validate) {
      this.validateCtx.origin = origin;
      let refusal: string | null;
      try {
        refusal = def.validate(this.state, command, this.validateCtx as ValidateContext<unknown>);
      } catch (err) {
        // `validate` est pure : l'état n'a pas bougé, on refuse sans corrompre la simulation.
        refusal = `Erreur pendant la validation : ${message(err)}`;
      }
      if (refusal !== null) {
        const rejection: CommandRejection = { seq, key, origin, message: refusal };
        this.pushEvent("commandRejected", rejection);
        return true;
      }
    }
    this.commandCtx.origin = origin;
    try {
      def.apply(this.state, command, this.commandCtx);
    } catch (err) {
      const type =
        typeof command === "object" && command !== null ? (command as { type?: unknown }).type : undefined;
      this.corrupt(`apply(${typeof type === "string" ? type : "?"})`, err);
      return false;
    }
    if (origin === "host") {
      this.journal.push({ tick: this.current, seq: seq!, command: command });
    }
    return true;
  }

  private corrupt(system: string, err: unknown): void {
    this.corrupted = { tick: this.current, system, cause: message(err) };
    this.queue.length = 0;
    this.pushEvent("corrupted", this.corrupted);
  }

  private firstDue(t: number): number {
    const due = this.schedDue;
    for (let i = 0; i < due.length; i++) if (due[i]! <= t) return i;
    return -1;
  }

  /** Retrait stable : l'ordre de programmation est conservé. */
  private removeScheduled(index: number): void {
    this.schedKeys.splice(index, 1);
    this.schedDue.splice(index, 1);
    this.schedCommands.splice(index, 1);
  }

  private scheduleCommand(key: string, delay: number, command: unknown): void {
    if (typeof key !== "string" || key.length === 0 || key.length > 64) {
      throw new RangeError("Clé de commande programmée invalide (1 à 64 caractères).");
    }
    if (!Number.isInteger(delay) || delay < 1)
      throw new RangeError(`Délai invalide : ${delay} (entier ≥ 1 attendu).`);
    const schema = this.definition.systemCommands;
    if (!schema) throw new Error("Aucune commande système déclarée (systemCommands).");
    const parsed = schema.safeParse(command);
    if (!parsed.success) throw new Error(`Commande système invalide pour « ${key} ».`);
    this.cancelCommand(key);
    const due = this.current + delay;
    this.schedKeys.push(key);
    this.schedDue.push(due);
    this.schedCommands.push(parsed.data);
    if (due < this.minDue) this.minDue = due;
  }

  private cancelCommand(key: string): void {
    const index = this.schedKeys.indexOf(key);
    if (index >= 0) this.removeScheduled(index);
  }

  private invalidate(channel: string): void {
    const index = this.channelIndex.get(channel);
    if (index === undefined) throw new RangeError(`Canal inconnu « ${channel} ».`);
    this.pending[index] = 1;
  }

  private pushEvent(name: string, data: unknown): void {
    if (this.events.length - this.eventsStart >= this.maxEvents) {
      this.eventsStart++;
      this.droppedEvents++;
      // Compaction amortie : le tableau ne dépasse jamais deux fois la limite.
      if (this.eventsStart >= this.maxEvents) {
        this.events.splice(0, this.eventsStart);
        this.eventsStart = 0;
      }
    }
    this.events.push({ name, data: data ?? null, tick: this.current });
  }

  private record(index: number, elapsed: number): void {
    this.sysLast[index] = elapsed;
    const runs = this.sysRuns[index]!;
    this.sysAvg[index] = runs === 0 ? elapsed : this.sysAvg[index]! * 0.9 + elapsed * 0.1;
    this.sysRuns[index] = runs + 1;
  }

  /** Vue en lecture seule des temps (accesseurs sur les Float64Array, aucune copie). */
  private makeProfileView(): SimProfileView {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- accesseurs de la vue
    const self = this;
    const systems: Record<string, { readonly last: number; readonly avg: number; readonly runs: number }> =
      {};
    this.definition.systems.forEach((s, i) => {
      systems[s.name] = Object.freeze({
        get last() {
          return self.sysLast[i]!;
        },
        get avg() {
          return self.sysAvg[i]!;
        },
        get runs() {
          return self.sysRuns[i]!;
        },
      });
    });
    return Object.freeze({
      tickMs: Object.freeze({
        get last() {
          return self.tickTimes[0]!;
        },
        get avg() {
          return self.tickTimes[1]!;
        },
      }),
      systems: Object.freeze(systems),
    });
  }

  /** Écarte les entrées plus anciennes que `retention` ticks. */
  private trimJournal(t: number, retention: number): void {
    const oldest = t - retention; // dernier tick à écarter
    if (oldest < 1) return;
    const journal = this.journal;
    let drop = 0;
    while (drop < journal.length && journal[drop]!.tick <= oldest) drop++;
    if (drop > 0) journal.splice(0, drop);
    this.journalFrom = oldest + 1;
  }

  // --- Snapshots ------------------------------------------------------------------------

  snapshot(): SimSnapshot<SimTypes<D>["full"]> {
    const channels: Record<string, unknown> = {};
    for (let c = 0; c < this.channelDefs.length; c++) {
      channels[this.channelNames[c]!] = this.channelDefs[c]!.build(this.state, this.snapshotCtx);
    }
    return {
      tick: this.ticks,
      full: this.definition.snapshot.full(this.state, this.snapshotCtx) as SimTypes<D>["full"],
      channels,
    };
  }

  drain(): DrainPayload {
    const channels: Record<string, unknown> = {};
    for (let c = 0; c < this.channelDefs.length; c++) {
      if (this.pending[c] === 0) continue;
      this.pending[c] = 0;
      channels[this.channelNames[c]!] = this.channelDefs[c]!.build(this.state, this.snapshotCtx);
    }
    const events = this.eventsStart === 0 ? this.events : this.events.slice(this.eventsStart);
    const droppedEvents = this.droppedEvents;
    this.events = [];
    this.eventsStart = 0;
    this.droppedEvents = 0;
    return { tick: this.ticks, channels, events, droppedEvents };
  }
}

/** Crée une simulation en mémoire, à partir de sa graine et de ses réglages. */
export function createSimulation<D extends AnySimulation>(
  definition: D,
  options: SimOptions<SimTypes<D>["settings"]> = {},
): Sim<D> {
  const settings = resolveSimSettings(definition, options.settings);
  const seed = options.seed ?? randomSeed();
  return new SimImpl(definition, settings, seed, createRng(seed), options).init();
}
