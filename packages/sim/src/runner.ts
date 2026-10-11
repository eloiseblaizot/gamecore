/**
 * Cadenceur d'une simulation (`createRunner`) : accumulateur à pas fixe.
 *
 * À chaque « frame », le temps écoulé (× vitesse × cadence) s'ajoute à un accumulateur ; on
 * exécute autant de ticks ENTIERS qu'il en contient. La simulation ne voit jamais le temps :
 * elle avance tick par tick, toujours complètement, et le journal note le tick de chaque
 * commande — le rejeu ne dépend donc pas de la machine.
 *
 * Si une frame doit rattraper plus de `maxTicksPerFrame` ticks (onglet en arrière-plan, machine
 * trop lente), on en exécute `maxTicksPerFrame`, on signale le retard (`onLag`) et on
 * abandonne la dette : la vitesse réelle descend sous la cible plutôt que de geler la page.
 */

import type { AnySimulation } from "./definition.js";
import type { DrainPayload, Sim } from "./simulation.js";

export interface RunnerOptions {
  /** Ticks par seconde à vitesse ×1 (par défaut : `definition.ticksPerSecond`, sinon 10). */
  ticksPerSecond?: number;
  /** Multiplicateur de vitesse (1 par défaut ; 0 = pause). */
  speed?: number;
  /** Ticks exécutés au plus par frame (30 par défaut) ; au-delà, retard signalé. */
  maxTicksPerFrame?: number;
  /** Horloge en ms (par défaut `performance.now`), injectable pour les tests. */
  now?: () => number;
  /**
   * Programme la prochaine frame (par défaut `setTimeout(fn, delayMs)`). `delayMs` est le
   * temps estimé avant le prochain tick ; un ordonnanceur comme `requestAnimationFrame`
   * peut l'ignorer.
   */
  schedule?: (fn: () => void, delayMs: number) => unknown;
  /** Annule une frame programmée (par défaut `clearTimeout`). */
  cancel?: (handle: unknown) => void;
  /** Appelé quand une frame a dû abandonner `ticksBehind` ticks. */
  onLag?: (ticksBehind: number) => void;
  /** Canaux et événements après chaque rafale de ticks. */
  onDrain?: (payload: DrainPayload) => void;
}

export interface RunnerStats {
  /** Cadence visée (ticks/s × vitesse). */
  targetTicksPerSecond: number;
  /** Cadence réellement obtenue sur la dernière seconde écoulée. */
  actualTicksPerSecond: number;
  /** Ticks abandonnés au total (retard). */
  droppedTicks: number;
  /** Vrai si la dernière frame a dû abandonner des ticks. */
  lagging: boolean;
}

export interface Runner<D extends AnySimulation = AnySimulation> {
  readonly sim: Sim<D>;
  /** Vrai entre `start` et `pause`/`stop` (même à vitesse 0). */
  readonly running: boolean;
  readonly speed: number;
  readonly ticksPerSecond: number;
  /** Démarre ou reprend (le temps passé en pause n'est pas rattrapé). */
  start(): void;
  /** Suspend ; `start` reprend. */
  pause(): void;
  /** Change la vitesse (0 = pause, sans arrêter le cadenceur). */
  setSpeed(speed: number): void;
  /** Exécute `ticks` ticks tout de suite (bouton « pas à pas »), puis publie. */
  step(ticks?: number): number;
  /** Exécute une frame tout de suite (boucles maison, tests) ; renvoie le nombre de ticks. */
  frame(): number;
  /** Arrête définitivement. */
  stop(): void;
  stats(): RunnerStats;
}

function defaultNow(): () => number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  if (!perf) throw new Error("Aucune horloge disponible : fournissez l'option `now`.");
  return () => perf.now();
}

const MAX_SPEED = 64;

/** Crée le cadenceur d'une simulation (arrêté : appeler `start`). */
export function createRunner<D extends AnySimulation>(sim: Sim<D>, options: RunnerOptions = {}): Runner<D> {
  const tps: number = options.ticksPerSecond ?? sim.definition.ticksPerSecond ?? 10;
  if (!(tps > 0 && tps <= 240)) throw new RangeError(`ticksPerSecond invalide : ${tps} (entre 0 et 240).`);
  const maxTicks = options.maxTicksPerFrame ?? 30;
  if (!(Number.isInteger(maxTicks) && maxTicks >= 1))
    throw new RangeError("maxTicksPerFrame : entier ≥ 1 attendu.");
  const now = options.now ?? defaultNow();
  const schedule = options.schedule ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
  const cancel =
    options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const checkSpeed = (value: number) => {
    if (!(Number.isFinite(value) && value >= 0 && value <= MAX_SPEED)) {
      throw new RangeError(`Vitesse invalide : ${value} (entre 0 et ${MAX_SPEED}).`);
    }
    return value;
  };

  let speed = checkSpeed(options.speed ?? 1);
  let running = false;
  let stopped = false;
  let handle: unknown = null;
  let last = 0;
  // Accumulateur en « ms × ticks/s » : un tick vaut 1000. Avec une horloge en ms entières et une
  // vitesse entière, le calcul est exact (pas de 0,999… qui retarde un tick).
  let acc = 0;
  let droppedTicks = 0;
  let lagging = false;
  // Mesure de la cadence réelle, par fenêtres d'au moins une seconde.
  let windowStart = 0;
  let windowTicks = 0;
  let actual = 0;

  const publish = () => {
    if (options.onDrain) options.onDrain(sim.drain());
  };

  const clear = () => {
    if (handle !== null) cancel(handle);
    handle = null;
  };

  const plan = () => {
    clear();
    if (!running || speed === 0 || sim.corrupted) return;
    handle = schedule(loop, Math.max(0, Math.ceil((1000 - acc) / (tps * speed))));
  };

  const run = (ticks: number): number => {
    if (ticks === 0) return 0;
    const done = sim.step(ticks);
    publish();
    return done;
  };

  const frame = (): number => {
    const t = now();
    const elapsed = Math.max(0, t - last);
    last = t;
    if (!running || speed === 0) return 0;
    acc += elapsed * tps * speed;
    let ticks = Math.floor(acc / 1000);
    acc -= ticks * 1000;
    lagging = ticks > maxTicks;
    if (lagging) {
      const behind = ticks - maxTicks;
      droppedTicks += behind;
      ticks = maxTicks;
      options.onLag?.(behind);
    }
    const done = run(ticks);
    windowTicks += done;
    if (t - windowStart >= 1000) {
      actual = (windowTicks * 1000) / (t - windowStart);
      windowStart = t;
      windowTicks = 0;
    }
    return done;
  };

  function loop() {
    handle = null;
    frame();
    plan();
  }

  const resetClock = () => {
    last = now();
    windowStart = last;
    windowTicks = 0;
  };

  return {
    sim,
    get running() {
      return running;
    },
    get speed() {
      return speed;
    },
    ticksPerSecond: tps,
    start() {
      if (stopped) throw new Error("Cadenceur arrêté : créez-en un nouveau.");
      if (running) return;
      running = true;
      resetClock();
      plan();
    },
    pause() {
      running = false;
      clear();
    },
    setSpeed(value) {
      checkSpeed(value);
      if (running) frame(); // le temps écoulé compte à l'ancienne vitesse
      speed = value;
      if (running) {
        resetClock();
        plan();
      }
    },
    step(ticks = 1) {
      if (stopped) throw new Error("Cadenceur arrêté : créez-en un nouveau.");
      return run(ticks);
    },
    frame() {
      if (stopped) return 0;
      const done = frame();
      if (running) plan();
      return done;
    },
    stop() {
      running = false;
      stopped = true;
      clear();
    },
    stats() {
      return { targetTicksPerSecond: tps * speed, actualTicksPerSecond: actual, droppedTicks, lagging };
    },
  };
}
