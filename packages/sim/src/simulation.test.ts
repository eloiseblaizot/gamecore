import { GameError } from "@gamecore/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { toy } from "./__fixtures__/toy.js";
import {
  defineSimulation,
  type ChannelName,
  type SimTypes,
  type SimulationDefinition,
} from "./definition.js";
import { createSimulation } from "./simulation.js";

type MiniState = { n: number };
type MiniDef = SimulationDefinition<
  MiniState,
  { type: "noop" },
  { type: "tick" },
  { n: number },
  null,
  string
>;

/** Définition minimale valide, à dériver dans les tests. */
const base = (): MiniDef => ({
  id: "mini",
  version: 1,
  settings: { schema: z.strictObject({ n: z.number().int() }), defaults: { n: 1 } },
  commands: z.strictObject({ type: z.literal("noop") }),
  systemCommands: z.strictObject({ type: z.literal("tick") }),
  create: () => ({ n: 0 }),
  apply: () => {},
  systems: [],
  snapshot: { full: () => null },
  codec: { encode: () => new Uint8Array(0), decode: () => ({ n: 0 }) },
});

const mini = (override: Partial<MiniDef> = {}) => defineSimulation({ ...base(), ...override });

describe("defineSimulation", () => {
  it("accepte une définition valide et la renvoie telle quelle", () => {
    const def = base();
    expect(defineSimulation(def)).toBe(def);
    expect(mini().id).toBe("mini");
  });

  it("infère les types (commandes, réglages, noms de canaux)", () => {
    expectTypeOf<ChannelName<typeof toy>>().toEqualTypeOf<"grid" | "stats" | "slow">();
    expectTypeOf<SimTypes<typeof toy>["settings"]>().toEqualTypeOf<{ size: number; growth: number }>();
    expectTypeOf<SimTypes<typeof toy>["systemCommand"]>().toEqualTypeOf<{ type: "pulse"; amount: number }>();
  });

  it.each([
    ["un identifiant invalide", { id: "Mini" }, /Identifiant invalide/],
    ["une version non entière", { version: 1.5 }, /Version invalide/],
    ["une cadence hors bornes", { ticksPerSecond: 0 }, /Cadence invalide/],
    ["une cadence trop élevée", { ticksPerSecond: 1000 }, /Cadence invalide/],
    [
      "des réglages par défaut non conformes",
      { settings: { schema: z.strictObject({ n: z.number().int() }), defaults: { n: 0.5 } } },
      /réglages par défaut/,
    ],
    ["un nom de système invalide", { systems: [{ name: "1er", update() {} }] }, /Nom de système invalide/],
    [
      "deux systèmes du même nom",
      {
        systems: [
          { name: "a", update() {} },
          { name: "a", update() {} },
        ],
      },
      /Deux systèmes/,
    ],
    [
      "un every de système invalide",
      { systems: [{ name: "a", every: 0, update() {} }] },
      /« every » du système/,
    ],
    [
      "un nom de canal invalide",
      { snapshot: { full: () => null, channels: { "bad name": { build: () => 1 } } } },
      /Nom de canal invalide/,
    ],
    [
      "un every de canal invalide",
      { snapshot: { full: () => null, channels: { c: { every: 2.5, build: () => 1 } } } },
      /« every » du canal/,
    ],
    [
      "une migration depuis la version courante",
      { migrate: { 1: (b: Uint8Array) => b } },
      /Migration depuis la version 1/,
    ],
  ] as [string, Partial<MiniDef>, RegExp][])("refuse %s", (_label, override, error) => {
    expect(() => mini(override)).toThrow(error);
  });
});

describe("createSimulation", () => {
  it("crée l'état au tick 0 avec le hasard de la graine et fusionne les réglages", () => {
    const sim = createSimulation(toy, { seed: "s", settings: { size: 4 } });
    expect(sim.tick).toBe(0);
    expect(sim.seed).toBe("s");
    expect(sim.settings).toEqual({ size: 4, growth: 1 });
    expect(Object.isFrozen(sim.settings)).toBe(true);
    expect(sim.state.cells).toHaveLength(16);
    expect(sim.drain().events).toEqual([{ name: "created", data: { size: 4 }, tick: 0 }]);
    // Même graine → même état initial ; graine différente → (très probablement) autre état.
    expect(createSimulation(toy, { seed: "s", settings: { size: 4 } }).hash()).toBe(sim.hash());
    expect(createSimulation(toy, { seed: "t", settings: { size: 4 } }).hash()).not.toBe(sim.hash());
  });

  it("tire une graine au hasard si aucune n'est donnée", () => {
    const sim = createSimulation(toy);
    expect(sim.seed).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuse des réglages invalides (BAD_REQUEST) et des options incohérentes", () => {
    expect(() => createSimulation(toy, { settings: { size: 1 } })).toThrow(GameError);
    expect(() => createSimulation(toy, { journalRetention: 0 })).toThrow(/journalRetention/);
  });

  it("avance tick par tick sans jamais en sauter", () => {
    const sim = createSimulation(toy, { seed: "s" });
    expect(sim.step()).toBe(1);
    expect(sim.step(59)).toBe(59);
    expect(sim.tick).toBe(60);
    expect(sim.step(0)).toBe(0);
    expect(() => sim.step(-1)).toThrow(RangeError);
    expect(() => sim.step(1.5)).toThrow(RangeError);
  });
});

describe("file de commandes", () => {
  it("applique les commandes au début du tick suivant, dans l'ordre d'arrivée, et les journalise", () => {
    const sim = createSimulation(toy, { seed: "s", settings: { growth: 0 } });
    const a = sim.dispatch({ type: "paint", x: 1, y: 1, value: 5 });
    const b = sim.dispatch({ type: "paint", x: 1, y: 1, value: 9 });
    expect(a).toEqual({ ok: true, seq: 1 });
    expect(b).toEqual({ ok: true, seq: 2 });
    expect(sim.state.cells[9]).not.toBe(9); // rien d'appliqué avant le tick
    sim.step();
    expect(sim.state.cells[9]).toBe(9); // la dernière arrivée gagne
    expect(sim.journal).toEqual([
      { tick: 1, seq: 1, command: { type: "paint", x: 1, y: 1, value: 5 } },
      { tick: 1, seq: 2, command: { type: "paint", x: 1, y: 1, value: 9 } },
    ]);
  });

  it("refuse tout de suite une commande mal formée (BAD_REQUEST)", () => {
    const sim = createSimulation(toy, { seed: "s" });
    for (const bad of [
      null,
      "paint",
      { type: "paint", x: 1 },
      { type: "paint", x: 1, y: 1, value: 1, extra: 1 },
    ]) {
      const result = sim.dispatch(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("BAD_REQUEST");
    }
  });

  it("refuse une commande système venue de l'hôte (FORBIDDEN), avant toute validation", () => {
    const sim = createSimulation(toy, { seed: "s" });
    const result = sim.dispatch({ type: "pulse", amount: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    sim.step();
    expect(sim.state.pulses).toBe(0);
  });

  it("n'applique ni ne journalise une commande refusée par validate, et émet commandRejected", () => {
    const sim = createSimulation(toy, { seed: "s", settings: { growth: 0 } });
    sim.drain();
    const before = sim.hash();
    const { seq } = sim.dispatch({ type: "paint", x: 99, y: 0, value: 1 }) as { seq: number };
    sim.step();
    expect(sim.journal).toEqual([]);
    expect(sim.state.painted).toBe(0);
    expect(sim.drain().events).toContainEqual({
      name: "commandRejected",
      data: { seq, key: null, origin: "host", message: "Case hors de la grille." },
      tick: 1,
    });
    expect(sim.hash()).not.toBe(before); // le tick a avancé, rien d'autre
  });

  it("traite une exception dans validate comme un refus, sans corrompre la simulation", () => {
    const sim = createSimulation(toy, { seed: "s" });
    sim.dispatch({ type: "fragile" });
    expect(sim.step()).toBe(1);
    expect(sim.corrupted).toBeNull();
    const rejected = sim.drain().events.find((e) => e.name === "commandRejected");
    expect(rejected?.data).toMatchObject({
      message: expect.stringContaining("validation en panne") as string,
    });
  });

  it("refuse au-delà de maxQueuedCommands (RATE_LIMITED)", () => {
    const sim = createSimulation(toy, { seed: "s", maxQueuedCommands: 2 });
    sim.dispatch({ type: "fragile" });
    sim.dispatch({ type: "fragile" });
    const third = sim.dispatch({ type: "fragile" });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe("RATE_LIMITED");
    sim.step();
    expect(sim.dispatch({ type: "fragile" }).ok).toBe(true); // la file a été vidée
  });

  it("garde seulement les journalRetention derniers ticks du journal", () => {
    const sim = createSimulation(toy, { seed: "s", journalRetention: 3 });
    for (let t = 1; t <= 6; t++) {
      sim.dispatch({ type: "paint", x: 0, y: 0, value: t });
      sim.step();
    }
    expect(sim.journal.map((e) => e.tick)).toEqual([4, 5, 6]);
    expect(sim.journalFrom).toBe(4);
    expect(createSimulation(toy, { seed: "s" }).journalFrom).toBe(0);
  });
});

describe("commandes système", () => {
  it("s'exécutent au tick d'échéance exact, avec origin = system", () => {
    const sim = createSimulation(toy, { seed: "s" });
    sim.dispatch({ type: "pulseIn", key: "p", delay: 3, amount: 2 }); // appliquée au tick 1 → due au tick 4
    sim.step();
    expect(sim.scheduled()).toEqual([{ key: "p", due: 4, command: { type: "pulse", amount: 2 } }]);
    sim.step(2);
    expect(sim.state.pulses).toBe(0);
    sim.step();
    expect(sim.state.pulses).toBe(2);
    expect(sim.scheduled()).toEqual([]);
    expect(sim.drain().events).toContainEqual({
      name: "pulse",
      data: { amount: 2, origin: "system", tick: 4 },
      tick: 4,
    });
    // Les commandes système ne sont pas journalisées (elles découlent du journal de l'hôte).
    expect(sim.journal.map((e) => e.command.type)).toEqual(["pulseIn"]);
  });

  it("une seule par clé : reprogrammer remplace, cancel annule", () => {
    const sim = createSimulation(toy, { seed: "s" });
    sim.dispatch({ type: "pulseIn", key: "p", delay: 2, amount: 1 });
    sim.dispatch({ type: "pulseIn", key: "p", delay: 5, amount: 3 });
    sim.dispatch({ type: "pulseIn", key: "q", delay: 2, amount: 1 });
    sim.step();
    expect(sim.scheduled().map((s) => [s.key, s.due])).toEqual([
      ["p", 6],
      ["q", 3],
    ]);
    sim.dispatch({ type: "cancelPulse", key: "q" });
    sim.dispatch({ type: "cancelPulse", key: "inconnue" }); // sans effet
    sim.step(10);
    expect(sim.state.pulses).toBe(3);
  });

  it("à échéance égale, s'exécutent dans l'ordre de programmation", () => {
    const sim = createSimulation(toy, { seed: "s" });
    sim.dispatch({ type: "pulseIn", key: "b", delay: 2, amount: 2 });
    sim.dispatch({ type: "pulseIn", key: "a", delay: 2, amount: 1 });
    sim.step(3);
    const pulses = sim.drain().events.filter((e) => e.name === "pulse");
    expect(pulses.map((e) => (e.data as { amount: number }).amount)).toEqual([2, 1]);
  });

  it("refuse une programmation invalide (délai, clé, commande, absence de schéma)", () => {
    const errors: unknown[] = [];
    const invalid: [string, number, unknown][] = [
      ["k", 0, { type: "tick" }],
      ["k", 1.5, { type: "tick" }],
      ["", 1, { type: "tick" }],
      ["x".repeat(65), 1, { type: "tick" }],
      ["k", 1, { type: "autre" }],
    ];
    const def = mini({
      systems: [
        {
          name: "probe",
          update(_state, ctx) {
            for (const [key, delay, command] of invalid) {
              try {
                ctx.schedule(key, delay, command as { type: "tick" });
              } catch (err) {
                errors.push(err);
              }
            }
          },
        },
      ],
    });
    const sim = createSimulation(def, { seed: "s" });
    sim.step();
    expect(errors).toHaveLength(5);
    expect(sim.scheduled()).toEqual([]);

    const { systemCommands: _unused, ...withoutSchema } = base();
    const noSchema = defineSimulation({
      ...withoutSchema,
      systems: [{ name: "probe", update: (_state, ctx) => ctx.schedule("k", 1, { type: "tick" }) }],
    });
    const broken = createSimulation(noSchema, { seed: "s" });
    broken.step();
    expect(broken.corrupted?.cause).toMatch(/Aucune commande système/);
  });
});

describe("systèmes", () => {
  it("s'exécutent dans l'ordre déclaré, et tous les every ticks", () => {
    const calls: string[] = [];
    const def = mini({
      systems: [
        { name: "a", update: (_state, ctx) => void calls.push(`a${ctx.tick}`) },
        { name: "b", every: 2, update: (_state, ctx) => void calls.push(`b${ctx.tick}`) },
      ],
    });
    createSimulation(def, { seed: "s" }).step(4);
    expect(calls).toEqual(["a1", "a2", "b2", "a3", "a4", "b4"]);
  });

  it("mesurent leurs temps sans influencer la simulation", () => {
    let now = 0;
    const sim = createSimulation(toy, { seed: "s", clock: () => (now += 1) });
    sim.step(3);
    const profile = sim.profile();
    expect(profile.systems.grow).toMatchObject({ last: 1, runs: 3 });
    expect(profile.systems.census!.runs).toBe(0); // every: 5
    expect(profile.tickMs.last).toBeGreaterThan(0);
    // Même partie sans profilage : même hash.
    const quiet = createSimulation(toy, { seed: "s", profile: false });
    quiet.step(3);
    expect(quiet.hash()).toBe(sim.hash());
    expect(quiet.profile().systems.grow!.runs).toBe(0);
  });

  it("exposent les temps en lecture seule dans ctx.profile", () => {
    const seen: number[] = [];
    const def = mini({
      systems: [
        { name: "work", update() {} },
        { name: "watch", update: (_state, ctx) => void seen.push(ctx.profile!.systems.work!.runs) },
      ],
    });
    createSimulation(def, { seed: "s", clock: () => 0 }).step(3);
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("canaux et drain", () => {
  it("publie les canaux échus (every) et invalidés, puis drain est vide", () => {
    const sim = createSimulation(toy, { seed: "s" });
    sim.drain();
    sim.step();
    let out = sim.drain();
    expect(Object.keys(out.channels)).toEqual(["grid"]);
    expect(out.channels.grid).toBe(sim.state.cells); // vue directe, aucune copie
    expect(sim.drain()).toEqual({ tick: 1, channels: {}, events: [], droppedEvents: 0 });

    sim.step(2); // tick 3 : slow (every 3)
    expect(Object.keys(sim.drain().channels)).toEqual(["grid", "slow"]);

    sim.dispatch({ type: "paint", x: 0, y: 0, value: 1 });
    sim.step(); // tick 4 : stats invalidé par apply
    out = sim.drain();
    expect(out.channels.stats).toEqual({ total: 3, painted: 1, pulses: 0 });
    sim.step(); // tick 5 : census invalide stats
    expect(Object.keys(sim.drain().channels)).toEqual(["grid", "stats"]);
  });

  it("snapshot renvoie le complet et tous les canaux", () => {
    const sim = createSimulation(toy, { seed: "s", settings: { size: 2 } });
    sim.step(2);
    const snap = sim.snapshot();
    expect(snap.tick).toBe(2);
    expect(snap.full).toEqual({ size: 2, cells: sim.state.cells, tick: 2 });
    expect(Object.keys(snap.channels)).toEqual(["grid", "stats", "slow"]);
    expect(snap.channels.slow).toBe(2);
  });

  it("invalidate d'un canal inconnu corrompt la simulation (erreur de programmation)", () => {
    const def = mini({ systems: [{ name: "bad", update: (_state, ctx) => ctx.invalidate("nope") }] });
    const sim = createSimulation(def, { seed: "s" });
    sim.step();
    expect(sim.corrupted).toMatchObject({ system: "bad", cause: "Canal inconnu « nope »." });
  });

  it("borne le tampon d'événements et compte les événements perdus", () => {
    const def = mini({ systems: [{ name: "spam", update: (_state, ctx) => ctx.emit("e", ctx.tick) }] });
    const sim = createSimulation(def, { seed: "s", maxBufferedEvents: 3 });
    sim.step(10);
    const out = sim.drain();
    expect(out.events.map((e) => e.data)).toEqual([8, 9, 10]);
    expect(out.droppedEvents).toBe(7);
    expect(sim.drain().droppedEvents).toBe(0);
  });
});

describe("corruption", () => {
  it("une exception dans apply met la simulation en lecture seule", () => {
    const sim = createSimulation(toy, { seed: "s" });
    sim.step(2);
    sim.dispatch({ type: "explode" });
    sim.dispatch({ type: "paint", x: 0, y: 0, value: 1 });
    expect(sim.step(5)).toBe(0);
    expect(sim.tick).toBe(2);
    expect(sim.corrupted).toEqual({ tick: 3, system: "apply(explode)", cause: "explosion après mutation" });
    expect(sim.drain().events).toContainEqual({ name: "corrupted", data: sim.corrupted, tick: 3 });
    const after = sim.dispatch({ type: "paint", x: 0, y: 0, value: 1 });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("INTERNAL");
    expect(sim.step()).toBe(0);
  });

  it("une exception dans un système aussi, avec son nom", () => {
    const sim = createSimulation(toy, { seed: "s" });
    sim.dispatch({ type: "armCrash", tick: 4 });
    expect(sim.step(10)).toBe(3);
    expect(sim.corrupted).toEqual({ tick: 4, system: "crash", cause: "boum" });
  });
});

describe("déterminisme", () => {
  const play = (seed: string) => {
    const sim = createSimulation(toy, { seed, settings: { growth: 3 } });
    for (let t = 0; t < 200; t++) {
      if (t % 7 === 0) sim.dispatch({ type: "paint", x: t % 8, y: (t >> 3) % 8, value: t });
      if (t % 11 === 0) sim.dispatch({ type: "pulseIn", key: `k${t % 3}`, delay: 1 + (t % 5), amount: 1 });
      sim.step();
    }
    return sim;
  };

  it("même graine + mêmes commandes = même hash", () => {
    expect(play("graine").hash()).toBe(play("graine").hash());
    expect(play("graine").hash()).not.toBe(play("autre").hash());
  });

  it("le hash couvre le RNG et les commandes programmées", () => {
    const a = createSimulation(toy, { seed: "s" });
    const b = createSimulation(toy, { seed: "s" });
    a.dispatch({ type: "pulseIn", key: "p", delay: 50, amount: 1 });
    b.dispatch({ type: "pulseIn", key: "p", delay: 51, amount: 1 });
    a.step();
    b.step();
    expect(a.state).toEqual(b.state);
    expect(a.hash()).not.toBe(b.hash());
  });

  it("utilise le hash de la définition s'il est fourni", () => {
    const def = mini({ hash: () => "constant" });
    const a = createSimulation(def, { seed: "s" });
    const b = createSimulation(def, { seed: "s" });
    a.state.n = 42; // invisible pour ce hash
    expect(a.hash()).toBe(b.hash());
  });

  it("ne copie jamais l'état pendant les ticks", () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    const sim = createSimulation(toy, { seed: "s" });
    const cells = sim.state.cells;
    sim.dispatch({ type: "paint", x: 0, y: 0, value: 1 });
    sim.step(100);
    sim.drain();
    expect(clone).not.toHaveBeenCalled();
    expect(sim.state.cells).toBe(cells);
    clone.mockRestore();
  });
});
