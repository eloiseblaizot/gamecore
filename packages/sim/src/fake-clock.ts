/**
 * Fausse horloge pour tester un cadenceur (`createRunner`) sans attendre : le temps n'avance
 * que sur `advance(ms)`, qui exécute dans l'ordre les frames programmées entre-temps.
 *
 *   const clock = createFakeClock();
 *   const runner = createRunner(sim, { now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
 *   runner.start();
 *   clock.advance(1000); // une seconde de simulation, instantanément
 */

export interface FakeClock {
  /** Temps courant, en ms. */
  now(): number;
  /** Programme `fn` dans `delayMs` ms ; renvoie un identifiant pour `cancel`. */
  schedule(fn: () => void, delayMs?: number): number;
  cancel(handle: unknown): void;
  /** Avance de `ms` ms en exécutant les tâches échues, dans l'ordre (échéance, puis programmation). */
  advance(ms: number): void;
  /** Tâches en attente. */
  readonly pending: number;
}

interface Task {
  id: number;
  at: number;
  fn: () => void;
}

/** Garde-fou contre une tâche qui se reprogramme sans faire avancer le temps. */
const MAX_TASKS_PER_ADVANCE = 1_000_000;

export function createFakeClock(start = 0): FakeClock {
  let time = start;
  let nextId = 1;
  const tasks: Task[] = [];

  const takeNext = (until: number): Task | null => {
    let best = -1;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      if (task.at > until) continue;
      if (best < 0 || task.at < tasks[best]!.at || (task.at === tasks[best]!.at && task.id < tasks[best]!.id))
        best = i;
    }
    return best < 0 ? null : tasks.splice(best, 1)[0]!;
  };

  return {
    now: () => time,
    schedule: (fn, delayMs = 0) => {
      const id = nextId++;
      tasks.push({ id, at: time + Math.max(0, delayMs), fn });
      return id;
    },
    cancel: (handle) => {
      const index = tasks.findIndex((t) => t.id === handle);
      if (index >= 0) tasks.splice(index, 1);
    },
    advance: (ms) => {
      if (!(Number.isFinite(ms) && ms >= 0)) throw new RangeError(`Durée invalide : ${ms}`);
      const target = time + ms;
      for (let n = 0; ; n++) {
        if (n >= MAX_TASKS_PER_ADVANCE)
          throw new Error("Trop de tâches : une tâche se reprogramme sans délai ?");
        const task = takeNext(target);
        if (!task) break;
        time = task.at;
        task.fn();
      }
      time = target;
    },
    get pending() {
      return tasks.length;
    },
  };
}
