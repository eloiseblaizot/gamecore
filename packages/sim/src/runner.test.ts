import { afterEach, describe, expect, it, vi } from "vitest";
import { toy } from "./__fixtures__/toy.js";
import { createFakeClock } from "./fake-clock.js";
import { createRunner, type RunnerOptions } from "./runner.js";
import { createSimulation, type DrainPayload } from "./simulation.js";

const setup = (options: RunnerOptions = {}) => {
  const clock = createFakeClock();
  const sim = createSimulation(toy, { seed: "s" });
  const drains: DrainPayload[] = [];
  const runner = createRunner(sim, {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onDrain: (payload) => drains.push(payload),
    ...options,
  });
  return { clock, sim, runner, drains };
};

describe("createRunner", () => {
  afterEach(() => vi.useRealTimers());

  it("exécute exactement ticksPerSecond ticks par seconde (cadence de la définition)", () => {
    const { clock, sim, runner, drains } = setup();
    expect(runner.ticksPerSecond).toBe(10);
    expect(runner.running).toBe(false);
    runner.start();
    runner.start(); // sans effet
    expect(runner.running).toBe(true);
    clock.advance(1000);
    expect(sim.tick).toBe(10);
    clock.advance(4500);
    expect(sim.tick).toBe(55);
    // Une publication par rafale, avec les canaux échus.
    expect(drains.length).toBeGreaterThan(0);
    expect(drains.at(-1)).toMatchObject({ tick: 55 });
    expect(drains.at(-1)!.channels).toHaveProperty("grid");
  });

  it("accumule les fractions de tick sans en perdre ni en ajouter", () => {
    const { clock, sim, runner } = setup({ ticksPerSecond: 3 });
    runner.start();
    for (let i = 0; i < 9; i++) clock.advance(111);
    expect(sim.tick).toBe(2); // 999 ms → 2,997 ticks
    clock.advance(1);
    expect(sim.tick).toBe(3);
    clock.advance(10_000);
    expect(sim.tick).toBe(33);
  });

  it("applique la vitesse, et 0 suspend sans arrêter", () => {
    const { clock, sim, runner } = setup({ speed: 2 });
    runner.start();
    clock.advance(1000);
    expect(sim.tick).toBe(20);
    runner.setSpeed(0);
    clock.advance(5000);
    expect(sim.tick).toBe(20);
    expect(runner.running).toBe(true);
    expect(clock.pending).toBe(0);
    runner.setSpeed(4);
    clock.advance(500);
    expect(sim.tick).toBe(40);
    expect(runner.stats().targetTicksPerSecond).toBe(40);
  });

  it("compte le temps écoulé à l'ancienne vitesse quand elle change", () => {
    const { clock, sim, runner } = setup();
    runner.start();
    clock.advance(1000);
    clock.advance(50); // 0,5 tick à ×1, pas encore de frame
    runner.setSpeed(4);
    clock.advance(240); // 9,6 ticks à ×4 : 0,5 + 9,6 = 10,1 → 10 ticks (9 si les 50 ms étaient perdues)
    expect(sim.tick).toBe(20);
  });

  it("pause fige la simulation, et le temps passé en pause n'est pas rattrapé", () => {
    const { clock, sim, runner } = setup();
    runner.start();
    clock.advance(500);
    runner.pause();
    expect(runner.running).toBe(false);
    clock.advance(10_000);
    expect(sim.tick).toBe(5);
    expect(runner.frame()).toBe(0); // une frame en pause n'exécute rien
    runner.start();
    clock.advance(500);
    expect(sim.tick).toBe(10);
  });

  it("borne le rattrapage à maxTicksPerFrame et signale le retard", () => {
    let now = 0;
    const lags: number[] = [];
    const sim = createSimulation(toy, { seed: "s" });
    const runner = createRunner(sim, {
      now: () => now,
      schedule: () => null, // frames pilotées à la main
      cancel: () => {},
      maxTicksPerFrame: 30,
      onLag: (behind) => lags.push(behind),
    });
    runner.start();
    now = 10_000; // 100 ticks dus d'un coup
    expect(runner.frame()).toBe(30);
    expect(lags).toEqual([70]);
    expect(runner.stats()).toMatchObject({ droppedTicks: 70, lagging: true });
    now += 100;
    expect(runner.frame()).toBe(1);
    expect(runner.stats().lagging).toBe(false);
    expect(sim.tick).toBe(31);
  });

  it("mesure la cadence réelle sur la dernière seconde", () => {
    const { clock, runner } = setup();
    runner.start();
    clock.advance(2000);
    expect(runner.stats().actualTicksPerSecond).toBeCloseTo(10, 0);
  });

  it("step exécute des ticks à la demande et publie", () => {
    const { sim, runner, drains } = setup();
    expect(runner.step(3)).toBe(3);
    expect(runner.step()).toBe(1);
    expect(runner.step(0)).toBe(0);
    expect(sim.tick).toBe(4);
    expect(drains).toHaveLength(2);
  });

  it("s'arrête de lui-même si la simulation se corrompt", () => {
    const { clock, sim, runner, drains } = setup();
    sim.dispatch({ type: "armCrash", tick: 3 });
    runner.start();
    clock.advance(1000);
    expect(sim.tick).toBe(2);
    expect(sim.corrupted).not.toBeNull();
    expect(clock.pending).toBe(0);
    expect(drains.flatMap((d) => d.events).some((e) => e.name === "corrupted")).toBe(true);
  });

  it("stop est définitif", () => {
    const { clock, sim, runner } = setup();
    runner.start();
    clock.advance(100);
    runner.stop();
    clock.advance(1000);
    expect(sim.tick).toBe(1);
    expect(runner.frame()).toBe(0);
    expect(() => runner.start()).toThrow(/arrêté/);
    expect(() => runner.step()).toThrow(/arrêté/);
  });

  it("refuse des options invalides", () => {
    const sim = createSimulation(toy, { seed: "s" });
    expect(() => createRunner(sim, { ticksPerSecond: 0 })).toThrow(RangeError);
    expect(() => createRunner(sim, { maxTicksPerFrame: 0 })).toThrow(RangeError);
    expect(() => createRunner(sim, { speed: -1 })).toThrow(RangeError);
    expect(() => createRunner(sim, { speed: 100 })).toThrow(RangeError);
    expect(() => createRunner(sim).setSpeed(Number.NaN)).toThrow(RangeError);
  });

  it("utilise par défaut performance.now et setTimeout", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const sim = createSimulation(toy, { seed: "s" });
    const runner = createRunner(sim);
    runner.start();
    vi.advanceTimersByTime(1000);
    expect(sim.tick).toBe(10);
    runner.pause();
    vi.advanceTimersByTime(1000);
    expect(sim.tick).toBe(10);
  });
});

describe("createFakeClock", () => {
  it("exécute les tâches dans l'ordre (échéance, puis programmation)", () => {
    const clock = createFakeClock(100);
    const order: string[] = [];
    clock.schedule(() => order.push(`b@${clock.now()}`), 20);
    clock.schedule(() => order.push(`a@${clock.now()}`), 10);
    clock.schedule(() => order.push(`c@${clock.now()}`), 20);
    const cancelled = clock.schedule(() => order.push("x"), 5);
    clock.cancel(cancelled);
    clock.cancel(999); // inconnu : sans effet
    expect(clock.pending).toBe(3);
    clock.advance(15);
    expect(order).toEqual(["a@110"]);
    expect(clock.now()).toBe(115);
    clock.advance(100);
    expect(order).toEqual(["a@110", "b@120", "c@120"]);
    expect(clock.now()).toBe(215);
  });

  it("exécute aussi les tâches programmées pendant l'avance", () => {
    const clock = createFakeClock();
    let runs = 0;
    const again = () => {
      runs++;
      if (runs < 5) clock.schedule(again, 10);
    };
    clock.schedule(again);
    clock.advance(1000);
    expect(runs).toBe(5);
  });

  it("refuse une durée invalide et une boucle sans délai", () => {
    const clock = createFakeClock();
    expect(() => clock.advance(-1)).toThrow(RangeError);
    const forever = () => void clock.schedule(forever, 0);
    clock.schedule(forever);
    expect(() => clock.advance(1)).toThrow(/Trop de tâches/);
  });
});
