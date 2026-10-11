import { describe, expect, it } from "vitest";
import { toy } from "./__fixtures__/toy.js";
import { defineSimulation } from "./definition.js";
import { replay } from "./replay.js";
import { createSimulation } from "./simulation.js";
import { DeterminismError, benchmark, expectDeterministic, type SimScript } from "./tools.js";

const script: SimScript<typeof toy> = {
  seed: "scénario",
  settings: { growth: 3 },
  ticks: 300,
  commands: [
    { tick: 1, command: { type: "paint", x: 1, y: 1, value: 3 } },
    { tick: 1, command: { type: "pulseIn", key: "a", delay: 100, amount: 2 } },
    { tick: 40, command: { type: "paint", x: 99, y: 1, value: 3 } }, // refusée par validate
    { tick: 50, command: { type: "cancelPulse", key: "a" } },
    { tick: 150, command: { type: "pulseIn", key: "b", delay: 10, amount: 1 } },
  ],
};

/** Variante de la simulation jouet dont un système a un défaut donné. */
const flawed = (update: (state: { pulses: number }) => void) =>
  defineSimulation({ ...toy, systems: [...toy.systems, { name: "flaw", update }] });

describe("replay", () => {
  it("retrouve exactement la simulation d'origine depuis la graine et le journal", () => {
    const sim = createSimulation(toy, { seed: "g", settings: { growth: 2 } });
    for (let t = 0; t < 50; t++) {
      if (t % 4 === 0) sim.dispatch({ type: "paint", x: t % 8, y: 2, value: t });
      if (t === 10) sim.dispatch({ type: "pulseIn", key: "k", delay: 5, amount: 3 });
      sim.step();
    }
    const replayed = replay(toy, {
      seed: "g",
      settings: { growth: 2 },
      journal: sim.journal,
      untilTick: sim.tick,
    });
    expect(replayed.tick).toBe(50);
    expect(replayed.hash()).toBe(sim.hash());
    expect(replayed.profile().systems.grow!.runs).toBe(0); // profilage désactivé par défaut
  });

  it("s'arrête au tick demandé, ou à la dernière commande", () => {
    const journal = [
      { tick: 3, command: { type: "paint", x: 0, y: 0, value: 1 } },
      { tick: 8, command: { type: "paint", x: 0, y: 0, value: 2 } },
    ];
    expect(replay(toy, { seed: "g", journal }).tick).toBe(8);
    const partial = replay(toy, { seed: "g", journal, untilTick: 5 });
    expect(partial.tick).toBe(5);
    expect(partial.journal).toHaveLength(1);
    expect(replay(toy, { seed: "g", journal: [] }).tick).toBe(0);
  });

  it("refuse un rejeu impossible", () => {
    expect(() => replay(toy, { journal: [] })).toThrow(/sans la graine/);
    expect(() => replay(toy, { seed: "g", journal: [], untilTick: -1 })).toThrow(RangeError);
    const unsorted = [
      { tick: 5, command: { type: "fragile" } },
      { tick: 2, command: { type: "fragile" } },
    ];
    expect(() => replay(toy, { seed: "g", journal: unsorted })).toThrow(/non trié/);
    expect(() => replay(toy, { seed: "g", journal: [{ tick: 0, command: { type: "fragile" } }] })).toThrow(
      /non trié/,
    );
    expect(() => replay(toy, { seed: "g", journal: [{ tick: 1, command: { type: "?" } }] })).toThrow(
      /refusée au tick 1/,
    );
    expect(() => replay(toy, { seed: "g", journal: [{ tick: 1, command: { type: "explode" } }] })).toThrow(
      /corrompu/,
    );
  });
});

describe("expectDeterministic", () => {
  it("valide une simulation déterministe (deux exécutions, sauvegarde rechargée, rejeu)", () => {
    const report = expectDeterministic(toy, script);
    expect(report.ticks).toBe(300);
    const journal = script.commands!.filter((c) => c.tick !== 40);
    expect(report.hash).toBe(replay(toy, { ...script, journal, untilTick: 300 }).hash());
    // 1 (initial) + ticks 100, 150 (sauvegarde), 200, 300 + rejeu
    expect(report.checks).toBe(6);
    expect(expectDeterministic(toy, script, { checkEvery: 1, saveAt: null, replay: false }).checks).toBe(301);
  });

  it("interdit Math.random et l'horloge, puis les restaure", () => {
    const random = flawed((state) => void (state.pulses += Math.random() > 2 ? 1 : 0));
    expect(() => expectDeterministic(random, script)).toThrow(/Math.random\(\) est interdit/);
    const now = flawed((state) => void (state.pulses += Date.now() > 0 ? 0 : 1));
    expect(() => expectDeterministic(now, script)).toThrow(/Date.now\(\) est interdit/);
    const date = flawed((state) => void (state.pulses += new Date().getTime() > 0 ? 0 : 1));
    expect(() => expectDeterministic(date, script)).toThrow(/new Date\(\) est interdit/);
    expect(Math.random()).toBeLessThan(1);
    expect(Date.now()).toBeGreaterThan(0);
    expect(new Date(0).getTime()).toBe(0);
  });

  it("donne le premier tick divergent (hasard non déterministe, sans les pièges)", () => {
    const random = flawed((state) => void (Math.random() < 0.5 && state.pulses++));
    let error: unknown;
    try {
      expectDeterministic(random, script, { guards: false });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DeterminismError);
    // Avec une chance sur deux à chaque tick, la divergence apparaît très tôt.
    expect((error as DeterminismError).tick).toBeGreaterThan(0);
    expect((error as DeterminismError).tick).toBeLessThan(60);
    expect((error as DeterminismError).hashes[0]).not.toBe((error as DeterminismError).hashes[1]);
  });

  it("détecte un état caché hors de `state`", () => {
    let hidden = 0;
    const leaky = flawed((state) => {
      hidden++;
      if (hidden % 2 === 0) state.pulses++;
    });
    expect(() => expectDeterministic(leaky, script)).toThrow(DeterminismError);
  });

  it("détecte un codec qui ne restitue pas tout l'état", () => {
    const lossy = defineSimulation({
      ...toy,
      codec: {
        encode: toy.codec.encode,
        decode: (bytes, v) => ({ ...toy.codec.decode(bytes, v), pulses: 0 }),
      },
    });
    const withPulses: SimScript<typeof toy> = {
      ...script,
      ticks: 10,
      commands: [{ tick: 1, command: { type: "pulseIn", key: "a", delay: 1, amount: 1 } }],
    };
    expect(() => expectDeterministic(lossy, withPulses)).toThrow(/codec/);
  });

  it("refuse un scénario invalide", () => {
    expect(() => expectDeterministic(toy, { seed: "s", ticks: -1 })).toThrow(RangeError);
    expect(() => expectDeterministic(toy, { seed: "s", ticks: 5 }, { checkEvery: 0 })).toThrow(RangeError);
    const late: SimScript<typeof toy> = {
      seed: "s",
      ticks: 5,
      commands: [{ tick: 6, command: { type: "fragile" } }],
    };
    expect(() => expectDeterministic(toy, late)).toThrow(/Tick de commande invalide/);
    const invalid = {
      seed: "s",
      ticks: 5,
      commands: [{ tick: 1, command: { type: "?" } }],
    } as unknown as SimScript<typeof toy>;
    expect(() => expectDeterministic(toy, invalid)).toThrow(/refusée au tick 1/);
    const crash: SimScript<typeof toy> = {
      seed: "s",
      ticks: 5,
      commands: [{ tick: 1, command: { type: "armCrash", tick: 3 } }],
    };
    expect(() => expectDeterministic(toy, crash, { saveAt: null })).toThrow(/corrompue au tick 3/);
  });
});

describe("benchmark", () => {
  it("mesure le temps par tick et par système (p50, p95)", () => {
    let now = 0;
    const report = benchmark(toy, { ...script, ticks: 200 }, { clock: () => (now += 0.5) });
    expect(report.warmup).toBe(20);
    expect(report.ticks).toBe(180);
    expect(report.tickMs.p50).toBeGreaterThan(0);
    expect(report.tickMs.p95).toBeGreaterThanOrEqual(report.tickMs.p50);
    expect(report.tickMs.max).toBeGreaterThanOrEqual(report.tickMs.p95);
    expect(report.systems.grow).toMatchObject({ runs: 180, p50: 0.5 });
    expect(report.systems.census!.runs).toBe(36); // every: 5
    expect(typeof report.heapDeltaBytes).toBe("number");
  });

  it("fonctionne avec l'horloge par défaut", () => {
    const report = benchmark(toy, { seed: "s", ticks: 30 }, { warmup: 0 });
    expect(report.ticks).toBe(30);
    expect(report.tickMs.mean).toBeGreaterThanOrEqual(0);
  });

  it("refuse un scénario trop court ou qui corrompt la simulation", () => {
    expect(() => benchmark(toy, { seed: "s", ticks: 5 }, { warmup: 5 })).toThrow(RangeError);
    const crash: SimScript<typeof toy> = {
      seed: "s",
      ticks: 20,
      commands: [{ tick: 1, command: { type: "armCrash", tick: 3 } }],
    };
    expect(() => benchmark(toy, crash)).toThrow(/corrompue au tick 3/);
  });
});
