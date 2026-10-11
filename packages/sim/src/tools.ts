/**
 * Outils de test : `expectDeterministic` (le déterminisme, vérifié de trois façons) et
 * `benchmark` (temps par tick et par système). Ils lèvent des erreurs ordinaires : ils
 * s'utilisent avec n'importe quel lanceur de tests.
 */

import type { AnySimulation, SimTypes } from "./definition.js";
import { replay } from "./replay.js";
import { createSimulation, loadSimulation, type Sim } from "./simulation.js";

/** Scénario rejouable : graine, réglages, commandes datées et durée. */
export interface SimScript<D extends AnySimulation = AnySimulation> {
  seed: string;
  settings?: Partial<SimTypes<D>["settings"]>;
  /** Commandes, appliquées pendant le tick `tick` (≥ 1), dans l'ordre du tableau. */
  commands?: readonly { readonly tick: number; readonly command: SimTypes<D>["command"] }[];
  /** Nombre de ticks à exécuter. */
  ticks: number;
}

export interface DeterminismOptions {
  /** Comparer les hashs tous les `checkEvery` ticks (100 par défaut ; 1 = à chaque tick). */
  checkEvery?: number;
  /**
   * Tick après lequel la seconde exécution est sauvegardée puis rechargée (milieu par défaut ;
   * `null` pour ne pas le faire). Détecte un `codec` infidèle ou un état caché hors de `state`.
   */
  saveAt?: number | null;
  /** Rejouer le journal à la fin et comparer (oui par défaut). */
  replay?: boolean;
  /** Interdire `Math.random`, `Date.now` et `new Date()` pendant l'exécution (oui par défaut). */
  guards?: boolean;
}

export interface DeterminismReport {
  ticks: number;
  hash: string;
  /** Nombre de comparaisons de hash effectuées. */
  checks: number;
}

/** Erreur levée par `expectDeterministic`, avec le premier tick divergent. */
export class DeterminismError extends Error {
  override readonly name = "DeterminismError";
  constructor(
    message: string,
    /** Premier tick où les hashs diffèrent (0 : dès `create`). */
    readonly tick: number,
    readonly hashes: readonly [string, string],
  ) {
    super(message);
  }
}

type Commands = Map<number, unknown[]>;

function indexCommands(script: SimScript): Commands {
  const byTick: Commands = new Map();
  for (const { tick, command } of script.commands ?? []) {
    if (!Number.isInteger(tick) || tick < 1 || tick > script.ticks) {
      throw new RangeError(`Tick de commande invalide dans le script : ${tick}.`);
    }
    const list = byTick.get(tick);
    if (list) list.push(command);
    else byTick.set(tick, [command]);
  }
  return byTick;
}

function dispatchAll(sim: Sim, commands: unknown[] | undefined, tick: number): void {
  if (!commands) return;
  for (const command of commands) {
    const result = sim.dispatch(command);
    if (!result.ok) throw new Error(`Commande du script refusée au tick ${tick} : ${result.error.message}`);
  }
}

/** Installe des pièges sur les sources de non-déterminisme ; renvoie la fonction de retrait. */
function installGuards(): () => void {
  const random = Math.random;
  const RealDate = Date;
  const forbidden = (what: string) => () => {
    throw new Error(
      `${what} est interdit dans une simulation : le hasard passe par ctx.random, le temps par ctx.tick.`,
    );
  };
  Math.random = forbidden("Math.random()");
  class GuardedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) forbidden("new Date()")();
      super(...(args as [number]));
    }
    static override now = forbidden("Date.now()") as () => number;
  }
  globalThis.Date = GuardedDate as DateConstructor;
  return () => {
    Math.random = random;
    globalThis.Date = RealDate;
  };
}

/**
 * Exécute deux fois le scénario en parallèle et compare les hashs ; la seconde exécution
 * passe par une sauvegarde/rechargement en cours de route ; enfin, le journal est rejoué
 * depuis la graine. Lève une `DeterminismError` qui donne le premier tick divergent.
 */
export function expectDeterministic<D extends AnySimulation>(
  definition: D,
  script: SimScript<D>,
  options: DeterminismOptions = {},
): DeterminismReport {
  if (!Number.isInteger(script.ticks) || script.ticks < 0)
    throw new RangeError(`ticks invalide : ${script.ticks}`);
  const checkEvery = options.checkEvery ?? 100;
  if (!Number.isInteger(checkEvery) || checkEvery < 1)
    throw new RangeError("checkEvery : entier ≥ 1 attendu.");
  const saveAt = options.saveAt === undefined ? Math.floor(script.ticks / 2) : options.saveAt;
  const commands = indexCommands(script as SimScript);
  const simOptions = { seed: script.seed, settings: script.settings, profile: false } as const;
  const uninstall = options.guards === false ? () => {} : installGuards();

  try {
    const fresh = () =>
      [createSimulation(definition, simOptions), createSimulation(definition, simOptions)] as const;
    /** Avance les deux exécutions d'un tick (la seconde est rechargée après `saveAt`). */
    const advance = (pair: [Sim<D>, Sim<D>], tick: number) => {
      for (const sim of pair) {
        dispatchAll(sim, commands.get(tick), tick);
        sim.step();
        // Une exception (y compris un piège ci-dessous) corrompt la simulation : on la remonte.
        if (sim.corrupted) throw new Error(`Simulation corrompue au tick ${tick} : ${sim.corrupted.cause}`);
      }
      if (tick === saveAt) pair[1] = loadSimulation(definition, pair[1].save(), { profile: false });
    };
    const fail = (tick: number, a: string, b: string, how: string): never => {
      throw new DeterminismError(
        `Simulation non déterministe : ${how} diverge au tick ${tick} (${a} ≠ ${b}).`,
        tick,
        [a, b],
      );
    };

    const pair: [Sim<D>, Sim<D>] = [...fresh()];
    let checks = 1;
    if (pair[0].hash() !== pair[1].hash()) fail(0, pair[0].hash(), pair[1].hash(), "l'état initial");
    let lastGood = 0;
    for (let tick = 1; tick <= script.ticks; tick++) {
      advance(pair, tick);
      if (tick % checkEvery !== 0 && tick !== script.ticks && tick !== saveAt) continue;
      checks++;
      if (pair[0].hash() === pair[1].hash()) {
        lastGood = tick;
        continue;
      }
      // Divergence entre deux contrôles : on rejoue depuis le début, en comparant à chaque tick.
      const again: [Sim<D>, Sim<D>] = [...fresh()];
      for (let t = 1; t <= tick; t++) {
        advance(again, t);
        if (t > lastGood && again[0].hash() !== again[1].hash()) {
          fail(
            t,
            again[0].hash(),
            again[1].hash(),
            saveAt !== null && t >= saveAt ? "la sauvegarde rechargée" : "la seconde exécution",
          );
        }
      }
      fail(tick, pair[0].hash(), pair[1].hash(), "la seconde exécution");
    }

    const hash = pair[0].hash();
    if (options.replay !== false) {
      checks++;
      const replayed = replay(definition, {
        seed: script.seed,
        settings: script.settings,
        journal: pair[0].journal,
        untilTick: script.ticks,
      });
      if (replayed.hash() !== hash) fail(script.ticks, hash, replayed.hash(), "le rejeu du journal");
    }
    return { ticks: script.ticks, hash, checks };
  } finally {
    uninstall();
  }
}

export interface TimingStats {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface BenchmarkReport {
  /** Ticks mesurés (hors échauffement). */
  ticks: number;
  warmup: number;
  /** Temps d'un tick complet, en ms. */
  tickMs: TimingStats;
  /** Temps par système, en ms, sur les ticks où il a tourné. */
  systems: Record<string, TimingStats & { runs: number }>;
  /**
   * Variation du tas JavaScript pendant la mesure, en octets, quand l'environnement l'expose
   * (Node) ; sinon `null`. Le ramasse-miettes la rend indicative : JavaScript n'expose pas
   * de compteur d'allocations.
   */
  heapDeltaBytes: number | null;
}

export interface BenchmarkOptions {
  /** Ticks d'échauffement non mesurés (10 % par défaut, 100 au plus). */
  warmup?: number;
  /** Horloge en ms (par défaut `performance.now`). */
  clock?: () => number;
}

function stats(samples: Float64Array, count: number): TimingStats {
  if (count === 0) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = samples.slice(0, count).sort();
  let sum = 0;
  for (let i = 0; i < count; i++) sum += sorted[i]!;
  const at = (q: number) => sorted[Math.min(count - 1, Math.floor(q * count))]!;
  return { mean: sum / count, p50: at(0.5), p95: at(0.95), max: sorted[count - 1]! };
}

function heapUsed(): number | null {
  const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  return typeof proc?.memoryUsage === "function" ? proc.memoryUsage().heapUsed : null;
}

/** Mesure le temps par tick et par système (p50, p95) sur un scénario. */
export function benchmark<D extends AnySimulation>(
  definition: D,
  script: SimScript<D>,
  options: BenchmarkOptions = {},
): BenchmarkReport {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  const clock = options.clock ?? (perf ? () => perf.now() : null);
  if (!clock) throw new Error("Aucune horloge disponible : fournissez l'option `clock`.");
  const warmup = options.warmup ?? Math.min(100, Math.floor(script.ticks / 10));
  const measured = script.ticks - warmup;
  if (!Number.isInteger(warmup) || warmup < 0 || measured < 1) {
    throw new RangeError("Scénario trop court pour la mesure (ticks ≤ échauffement).");
  }
  const commands = indexCommands(script as SimScript);
  const sim = createSimulation(definition, { seed: script.seed, settings: script.settings, clock });
  const names = definition.systems.map((s) => s.name);
  const tickSamples = new Float64Array(measured);
  const systemSamples = names.map(() => new Float64Array(measured));
  const counts = new Array<number>(names.length).fill(0);
  const runsBefore = new Array<number>(names.length).fill(0);

  let heapStart: number | null = null;
  for (let tick = 1; tick <= script.ticks; tick++) {
    if (tick === warmup + 1) {
      const profile = sim.profile();
      names.forEach((name, s) => (runsBefore[s] = profile.systems[name]!.runs));
      heapStart = heapUsed();
    }
    dispatchAll(sim, commands.get(tick), tick);
    const start = clock();
    sim.step();
    const elapsed = clock() - start;
    if (sim.corrupted) throw new Error(`Simulation corrompue au tick ${tick} : ${sim.corrupted.cause}`);
    if (tick <= warmup) continue;
    const i = tick - warmup - 1;
    tickSamples[i] = elapsed;
    const profile = sim.profile();
    names.forEach((name, s) => {
      const p = profile.systems[name]!;
      if (p.runs > runsBefore[s]!) systemSamples[s]![counts[s]!++] = p.last;
      runsBefore[s] = p.runs;
    });
  }
  const heapEnd = heapUsed();

  const systems: BenchmarkReport["systems"] = {};
  names.forEach((name, s) => {
    systems[name] = { ...stats(systemSamples[s]!, counts[s]!), runs: counts[s]! };
  });
  return {
    ticks: measured,
    warmup,
    tickMs: stats(tickSamples, measured),
    systems,
    heapDeltaBytes: heapStart !== null && heapEnd !== null ? heapEnd - heapStart : null,
  };
}
