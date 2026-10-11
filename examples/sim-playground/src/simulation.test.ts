import { GameError } from "@gamecore/core";
import { createSimulation, decodeSave, loadSimulation, type Sim } from "@gamecore/sim";
import { benchmark, expectDeterministic, type SimScript } from "@gamecore/sim/testing";
import { describe, expect, it } from "vitest";
import { EMPTY, FOX, RABBIT, foxesAndRabbits } from "./simulation";

type Eco = Sim<typeof foxesAndRabbits>;

/** Grille vide de 16 × 16, sans changement de saison pendant le test. */
const empty = (seasonTicks = 100_000): Eco =>
  createSimulation(foxesAndRabbits, {
    seed: "test",
    settings: { size: 16, rabbitDensity: 0, foxDensity: 0, seasonTicks },
  });

const countOf = (sim: Eco, kind: number) => sim.state.cells.filter((c) => c === kind).length;

describe("Renards et lapins — règles", () => {
  it("peuple la grille selon les densités, avec la graine", () => {
    const sim = createSimulation(foxesAndRabbits, { seed: "a" });
    expect(sim.state.size).toBe(128);
    expect(sim.state.rabbits).toBe(countOf(sim, RABBIT));
    expect(sim.state.foxes).toBe(countOf(sim, FOX));
    expect(sim.state.rabbits / 16384).toBeCloseTo(0.15, 1);
    expect(createSimulation(foxesAndRabbits, { seed: "a" }).hash()).toBe(sim.hash());
  });

  it("ajoute des lapins autour de la case cliquée, sur des cases vides", () => {
    const sim = empty();
    sim.dispatch({ type: "addRabbits", x: 8, y: 8, count: 20 });
    sim.step();
    expect(countOf(sim, RABBIT)).toBeGreaterThanOrEqual(20); // 20 posés, dont certains déjà reproduits
    expect(sim.journal).toHaveLength(1);
  });

  it("refuse une case hors de la carte (sans journaliser)", () => {
    const sim = empty();
    sim.drain();
    sim.dispatch({ type: "addFoxes", x: 20, y: 3, count: 5 });
    sim.step();
    expect(sim.journal).toEqual([]);
    expect(sim.drain().events).toContainEqual(
      expect.objectContaining({
        name: "commandRejected",
        data: expect.objectContaining({ message: "Case hors de la carte." }),
      }),
    );
  });

  it("refuse les commandes mal formées et la saison envoyée par l'hôte", () => {
    const sim = empty();
    expect(sim.dispatch({ type: "addRabbits", x: 1, y: 1, count: 0 }).ok).toBe(false);
    expect(sim.dispatch({ type: "addRabbits", x: -1, y: 1, count: 1 }).ok).toBe(false);
    const season = sim.dispatch({ type: "season", index: 2 });
    expect(season.ok).toBe(false);
    if (!season.ok) expect(season.error.code).toBe("FORBIDDEN");
  });

  it("un renard sans proie meurt de faim, un renard qui mange survit", () => {
    const sim = empty();
    sim.dispatch({ type: "addFoxes", x: 8, y: 8, count: 1 });
    sim.step(29);
    expect(countOf(sim, FOX)).toBe(1);
    sim.step(2);
    expect(countOf(sim, FOX)).toBe(0);

    const fed = empty();
    fed.dispatch({ type: "addRabbits", x: 8, y: 8, count: 120 });
    fed.dispatch({ type: "addFoxes", x: 8, y: 8, count: 3 });
    fed.step(60);
    expect(countOf(fed, FOX)).toBeGreaterThan(0);
  });

  it("les renards ajoutés peuvent prendre la place de lapins (grille pleine)", () => {
    const sim = empty();
    sim.state.cells.fill(RABBIT);
    sim.dispatch({ type: "addFoxes", x: 4, y: 4, count: 10 });
    sim.step();
    expect(countOf(sim, FOX)).toBeGreaterThanOrEqual(10);
  });

  it("les lapins vieillissent et meurent", () => {
    const sim = empty();
    sim.dispatch({ type: "addRabbits", x: 8, y: 8, count: 1 });
    sim.step();
    const index = sim.state.cells.findIndex((c) => c === RABBIT);
    // Un seul lapin, sur une grille qu'il ne peut plus quitter : on le vieillit à la main.
    sim.state.cells.fill(EMPTY);
    sim.state.cells[index] = RABBIT;
    sim.state.energy[index] = 300;
    sim.step();
    expect(countOf(sim, RABBIT)).toBe(0);
  });

  it("fait tourner les saisons (commande système) et ramène une espèce éteinte", () => {
    const sim = empty(10);
    sim.drain();
    sim.step(10);
    expect(sim.state.season).toBe(1);
    const events = sim.drain().events.filter((e) => e.name === "season");
    expect(events).toEqual([{ name: "season", data: { index: 1, name: "été" }, tick: 10 }]);
    // Grille vide au départ : l'immigration a ramené lapins et renards.
    expect(countOf(sim, RABBIT)).toBeGreaterThan(100);
    expect(countOf(sim, FOX)).toBeGreaterThan(0);
    sim.step(30);
    expect(sim.state.season).toBe(0); // printemps → été → automne → hiver → printemps
    expect(sim.scheduled()).toEqual([{ key: "season", due: 50, command: { type: "season", index: 1 } }]);
  });

  it("publie la grille à chaque tick et les statistiques au recensement", () => {
    const sim = createSimulation(foxesAndRabbits, { seed: "a", settings: { size: 32 } });
    sim.drain();
    sim.step(4);
    expect(Object.keys(sim.drain().channels)).toEqual(["grid"]);
    sim.step();
    const out = sim.drain();
    expect(out.channels.grid).toBe(sim.state.cells);
    expect(out.channels.stats).toEqual({ rabbits: sim.state.rabbits, foxes: sim.state.foxes, season: 0 });
  });
});

describe("Renards et lapins — sauvegarde", () => {
  it("sauvegarde et recharge à l'identique, sans le brouillon du tick", () => {
    const sim = createSimulation(foxesAndRabbits, { seed: "s", settings: { size: 64 } });
    sim.dispatch({ type: "addFoxes", x: 3, y: 3, count: 30 });
    sim.step(321);
    const bytes = sim.save();
    const loaded = loadSimulation(foxesAndRabbits, bytes);
    expect(loaded.hash()).toBe(sim.hash());
    expect(loaded.state.moved).toHaveLength(64 * 64);
    sim.step(200);
    loaded.step(200);
    expect(loaded.hash()).toBe(sim.hash());
    // ~3 octets par case, plus l'en-tête.
    expect(bytes.length).toBeLessThan(64 * 64 * 3 + 1024);
  });

  it("refuse une grille incohérente", () => {
    const sim = empty();
    const save = decodeSave(foxesAndRabbits, sim.save());
    const tamper = (patch: Partial<typeof save.state>) => {
      const bytes = foxesAndRabbits.codec.encode({ ...save.state, ...patch });
      return () => foxesAndRabbits.codec.decode(bytes, 1);
    };
    expect(tamper({ size: 17 })).toThrow(/incohérente/);
    expect(tamper({ season: 7 })).toThrow(/incohérente/);
    const cells = save.state.cells.slice();
    cells[0] = 9;
    expect(tamper({ cells })).toThrow(/Case inconnue/);
    // Et via le chargement : un GameError BAD_REQUEST.
    const broken = sim.save();
    broken[broken.length - 1] = broken.at(-1)! ^ 0xff;
    expect(() => loadSimulation(foxesAndRabbits, broken)).toThrow(GameError);
  });
});

describe("Renards et lapins — déterminisme et performances", () => {
  // Grille de 64 × 64 : 10 000 ticks exécutés trois fois restent rapides en CI.
  const script: SimScript<typeof foxesAndRabbits> = {
    seed: "déterminisme",
    settings: { size: 64 },
    ticks: 10_000,
    commands: [
      { tick: 1, command: { type: "addFoxes", x: 32, y: 32, count: 50 } },
      { tick: 900, command: { type: "addRabbits", x: 10, y: 60, count: 500 } },
      { tick: 2_500, command: { type: "addRabbits", x: 10, y: 60, count: 500 } },
      { tick: 7_000, command: { type: "addFoxes", x: 63, y: 0, count: 200 } },
    ],
  };

  it("est déterministe sur 10 000 ticks (deux exécutions, sauvegarde rechargée, rejeu)", () => {
    const report = expectDeterministic(foxesAndRabbits, script, { checkEvery: 500 });
    expect(report.ticks).toBe(10_000);
  }, 60_000);

  it("tient largement dans le budget d'un tick (seuil volontairement large)", () => {
    const commands = script.commands!.filter((c) => c.tick <= 1_000);
    const report = benchmark(foxesAndRabbits, { ...script, settings: {}, commands, ticks: 1_000 });
    // 10 ticks/s laissent 100 ms par tick ; on exige bien moins, même sur une machine de CI lente.
    expect(report.tickMs.p95).toBeLessThan(20);
    expect(report.systems.animals!.runs).toBe(900);
    expect(report.systems.census!.runs).toBe(180);
  });
});
