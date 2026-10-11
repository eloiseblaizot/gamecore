import { GameError } from "@gamecore/core";
import { describe, expect, it } from "vitest";
import { toy, type ToyState } from "./__fixtures__/toy.js";
import { ByteReader, ByteWriter } from "./bytes.js";
import { defineSimulation } from "./definition.js";
import { replay } from "./replay.js";
import { writeSave, type SimSaveInput } from "./save.js";
import { createSimulation, decodeSave, encodeSave, loadSimulation } from "./simulation.js";

/** Une partie avec un peu de tout : commandes, commande programmée en attente, hasard. */
const played = () => {
  const sim = createSimulation(toy, { seed: "partie", settings: { size: 6, growth: 2 } });
  sim.dispatch({ type: "paint", x: 2, y: 3, value: 7 });
  sim.dispatch({ type: "pulseIn", key: "p", delay: 20, amount: 4 });
  sim.step(5);
  sim.dispatch({ type: "paint", x: 0, y: 0, value: 1 });
  sim.step(5);
  return sim;
};

const expectBadRequest = (fn: () => unknown, message?: RegExp) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GameError);
    expect((err as GameError).code).toBe("BAD_REQUEST");
    if (message) expect((err as GameError).message).toMatch(message);
    return;
  }
  throw new Error("une erreur BAD_REQUEST était attendue");
};

/** Réécrit une sauvegarde valide en modifiant certains champs. */
const rewrite = (patch: Partial<SimSaveInput<typeof toy>>) => {
  const save = decodeSave(toy, played().save());
  return writeSave(toy, { ...save, ...patch });
};

describe("sauvegarde et chargement", () => {
  it("restitue exactement la simulation (même hash), qui continue à l'identique", () => {
    const sim = played();
    const bytes = sim.save();
    expect(encodeSave(sim)).toEqual(bytes);
    expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe("GCSIM");

    const loaded = loadSimulation(toy, bytes);
    expect(loaded.tick).toBe(10);
    expect(loaded.hash()).toBe(sim.hash());
    expect(loaded.seed).toBe("partie");
    expect(loaded.settings).toEqual({ size: 6, growth: 2 });
    expect(loaded.journal).toEqual(sim.journal);
    expect(loaded.scheduled()).toEqual([{ key: "p", due: 21, command: { type: "pulse", amount: 4 } }]);

    // La commande programmée survit à la sauvegarde, et les numéros de commande continuent.
    sim.step(30);
    loaded.step(30);
    expect(loaded.state.pulses).toBe(4);
    expect(loaded.hash()).toBe(sim.hash());
    expect(loaded.dispatch({ type: "fragile" })).toEqual(sim.dispatch({ type: "fragile" }));
  });

  it("decodeSave expose le contenu sans créer de simulation", () => {
    const sim = played();
    const save = decodeSave(toy, sim.save());
    expect(save).toMatchObject({
      id: "toy",
      savedVersion: 1,
      tick: 10,
      seed: "partie",
      seq: 3,
      journalFrom: 0,
    });
    expect(save.rng).toEqual(sim.rngState());
    expect(save.hash).toBe(sim.hash());
    expect(save.state.cells).toEqual(sim.state.cells);
  });

  it("conserve une graine absente et un journal tronqué", () => {
    const bytes = rewrite({ seed: null, journal: [], journalFrom: 11 });
    const loaded = loadSimulation(toy, bytes);
    expect(loaded.seed).toBeNull();
    expect(loaded.journalFrom).toBe(11);
  });

  it("refuse de sauvegarder une simulation corrompue", () => {
    const sim = createSimulation(toy, { seed: "s" });
    sim.dispatch({ type: "explode" });
    sim.step();
    expect(() => sim.save()).toThrow(expect.objectContaining({ code: "INTERNAL" }) as Error);
  });

  describe("refuse un fichier invalide (BAD_REQUEST)", () => {
    const valid = () => played().save();

    it("pas une sauvegarde, tronquée, ou avec des données en trop", () => {
      expectBadRequest(
        () => loadSimulation(toy, new TextEncoder().encode("bonjour tout le monde")),
        /pas une sauvegarde/,
      );
      expectBadRequest(() => loadSimulation(toy, valid().subarray(0, 40)), /tronquée/);
      const extra = new Uint8Array(valid().length + 1);
      extra.set(valid());
      expectBadRequest(() => loadSimulation(toy, extra), /en trop/);
      expectBadRequest(() => loadSimulation(toy, "GCSIM" as unknown as Uint8Array), /octets attendus/);
    });

    it("trop volumineux", () => {
      expectBadRequest(() => loadSimulation(toy, valid(), { maxBytes: 100 }), /volumineuse/);
    });

    it("format d'en-tête inconnu, autre simulation, version plus récente", () => {
      const header = (format: number, id: string, version: number) => {
        const w = new ByteWriter();
        for (const c of "GCSIM") w.u8(c.charCodeAt(0));
        return w.u8(format).string(id).u32(version).finish();
      };
      expectBadRequest(() => loadSimulation(toy, header(2, "toy", 1)), /Format de sauvegarde 2/);
      expectBadRequest(() => loadSimulation(toy, header(1, "autre", 1)), /autre simulation/);
      expectBadRequest(() => loadSimulation(toy, header(1, "toy", 0)), /Version de sauvegarde invalide/);
      expectBadRequest(() => loadSimulation(toy, header(1, "toy", 9)), /plus récente/);
    });

    it("réglages, journal ou commandes programmées incohérents", () => {
      expectBadRequest(() => loadSimulation(toy, rewrite({ settings: { size: 1, growth: 0 } })), /Réglages/);
      const entry = (tick: number, seq: number, command: unknown = { type: "fragile" }) =>
        ({ tick, seq, command }) as never;
      expectBadRequest(
        () => loadSimulation(toy, rewrite({ journal: [entry(5, 1), entry(4, 2)] })),
        /journal incohérent/,
      );
      expectBadRequest(() => loadSimulation(toy, rewrite({ journal: [entry(11, 1)] })), /journal incohérent/);
      expectBadRequest(() => loadSimulation(toy, rewrite({ journal: [entry(2, 9)] })), /journal incohérent/);
      expectBadRequest(
        () => loadSimulation(toy, rewrite({ journal: [entry(2, 1, { type: "?" })] })),
        /commande du journal/,
      );
      expectBadRequest(() => loadSimulation(toy, rewrite({ journalFrom: 50 })), /début du journal/);
      const scheduled = (key: string, due: number, command: unknown = { type: "pulse", amount: 1 }) =>
        ({ key, due, command }) as never;
      expectBadRequest(
        () => loadSimulation(toy, rewrite({ scheduled: [scheduled("a", 10)] })),
        /incohérentes/,
      );
      expectBadRequest(
        () => loadSimulation(toy, rewrite({ scheduled: [scheduled("a", 12), scheduled("a", 13)] })),
        /incohérentes/,
      );
      expectBadRequest(
        () => loadSimulation(toy, rewrite({ scheduled: [scheduled("a", 12, { type: "paint" })] })),
        /commande programmée/,
      );
      expectBadRequest(() => loadSimulation(toy, rewrite({ hash: "pas-un-hash" })), /hash/);
      expectBadRequest(() => loadSimulation(toy, rewrite({ seed: "x".repeat(300) })), /graine/);
    });

    it("JSON illisible ou de mauvaise forme", () => {
      // Remplace la chaîne des réglages par du texte qui n'est pas du JSON.
      const save = decodeSave(toy, valid());
      const broken = writeSave(toy, { ...save, settings: undefined as never });
      expectBadRequest(() => loadSimulation(toy, broken), /réglages illisible|Réglages/);
      const badJournal = writeSave(toy, { ...save, journal: [{ tick: 0, seq: 1, command: {} }] as never });
      expectBadRequest(() => loadSimulation(toy, badJournal), /journal/);
      const badScheduled = writeSave(toy, {
        ...save,
        scheduled: [{ key: "", due: 50, command: {} }] as never,
      });
      expectBadRequest(() => loadSimulation(toy, badScheduled), /commandes programmées/);
    });

    it("UTF-8 invalide dans l'en-tête", () => {
      const w = new ByteWriter();
      for (const c of "GCSIM") w.u8(c.charCodeAt(0));
      w.u8(1).bytes(new Uint8Array([0xff, 0xfe]));
      expectBadRequest(() => loadSimulation(toy, w.finish()), /tronquée ou invalide/);
    });

    it("état illisible par le codec", () => {
      const save = decodeSave(toy, valid());
      const def = defineSimulation({ ...toy, codec: { ...toy.codec, encode: () => new Uint8Array(1) } });
      const bytes = writeSave(def, { ...save });
      expectBadRequest(() => loadSimulation(toy, bytes), /État illisible/);
    });

    it("état altéré : le hash ne correspond plus (sauf verifyHash: false)", () => {
      const sim = played();
      const save = decodeSave(toy, sim.save());
      const tampered: ToyState = { ...save.state, pulses: 999 };
      const bytes = writeSave(toy, { ...save, state: tampered });
      expectBadRequest(() => loadSimulation(toy, bytes), /altérée/);
      expect(loadSimulation(toy, bytes, { verifyHash: false }).state.pulses).toBe(999);
    });
  });
});

describe("migrations", () => {
  interface ToyV2 extends ToyState {
    bonus: number;
  }
  const v2 = defineSimulation({
    ...toy,
    version: 2,
    create: (ctx): ToyV2 => ({ ...toy.create(ctx), bonus: 0 }),
    codec: {
      encode: (state: ToyV2) => new ByteWriter().bytes(toy.codec.encode(state)).u32(state.bonus).finish(),
      decode: (bytes: Uint8Array): ToyV2 => {
        const r = new ByteReader(bytes);
        const base = toy.codec.decode(r.bytesValue(), 1);
        return { ...base, bonus: r.u32() };
      },
    },
    migrate: {
      // v1 → v2 : l'état v1 est enveloppé, avec un bonus de 5.
      1: (bytes: Uint8Array) => new ByteWriter().bytes(bytes).u32(5).finish(),
    },
  });

  it("applique la migration v1 → v2 et abandonne le journal", () => {
    const old = played();
    const loaded = loadSimulation(v2, old.save());
    expect(loaded.tick).toBe(10);
    expect((loaded.state as ToyV2).bonus).toBe(5); // (l'état v2 étend celui de la simulation jouet)
    expect(loaded.state.cells).toEqual(old.state.cells);
    expect(loaded.journal).toEqual([]);
    expect(loaded.journalFrom).toBe(11);
    expect(loaded.scheduled()).toEqual(old.scheduled());
    expect(decodeSave(v2, old.save()).savedVersion).toBe(1);
    // Et la sauvegarde suivante est en v2, rechargeable avec vérification du hash.
    loaded.step(3);
    expect(loadSimulation(v2, loaded.save()).hash()).toBe(loaded.hash());
  });

  it("refuse s'il manque un maillon ou si une migration échoue", () => {
    const v3 = defineSimulation({ ...v2, version: 3, migrate: { 2: (b: Uint8Array) => b } });
    expectBadRequest(() => loadSimulation(v3, played().save()), /aucune migration depuis la version 1/);
    const failing = defineSimulation({
      ...v2,
      migrate: {
        1: () => {
          throw new Error("format inconnu");
        },
      },
    });
    expectBadRequest(
      () => loadSimulation(failing, played().save()),
      /Migration depuis la version 1 impossible : format inconnu/,
    );
  });
});

describe("compaction du journal", () => {
  it("prend une sauvegarde de base au-delà de maxJournalEntries, d'où l'on peut rejouer", () => {
    const sim = createSimulation(toy, { seed: "s", maxJournalEntries: 3 });
    expect(() => createSimulation(toy, { maxJournalEntries: 0 })).toThrow(RangeError);
    for (let t = 1; t <= 10; t++) {
      sim.dispatch({ type: "paint", x: t % 8, y: 0, value: t });
      sim.step();
    }
    // Compactions aux ticks 4 et 8 : le journal ne garde que les ticks 9 et 10.
    expect(sim.journal.map((e) => e.tick)).toEqual([9, 10]);
    expect(sim.journalFrom).toBe(9);
    expect(sim.journalBase).not.toBeNull();
    const base = decodeSave(toy, sim.journalBase!);
    expect(base.tick).toBe(8);
    expect(base.journal).toEqual([]);

    const replayed = replay(toy, { base: sim.journalBase, journal: sim.journal, untilTick: sim.tick });
    expect(replayed.hash()).toBe(sim.hash());
  });
});
