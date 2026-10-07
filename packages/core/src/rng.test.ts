import { describe, expect, it } from "vitest";
import { createRng, randomSeed, seedFromString } from "./rng.js";

describe("rng", () => {
  it("est déterministe : même graine, même séquence", () => {
    const a = createRng("partie-42");
    const b = createRng("partie-42");
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(createRng("autre").next()).not.toBe(seqA[0]);
  });

  it("reprend exactement là où il s'était arrêté à partir de son état", () => {
    const rng = createRng("reprise");
    for (let i = 0; i < 10; i++) rng.next();
    const saved = rng.state();
    const expected = Array.from({ length: 5 }, () => rng.next());
    const resumed = createRng(saved);
    expect(Array.from({ length: 5 }, () => resumed.next())).toEqual(expected);
  });

  it("produit des flottants dans [0, 1) et des entiers dans les bornes", () => {
    const rng = createRng("bornes");
    for (let i = 0; i < 2000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = rng.int(-3, 3);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(-3);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  it("couvre toutes les valeurs de façon à peu près uniforme", () => {
    const rng = createRng("uniforme");
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 60_000; i++) counts[rng.int(0, 5)]!++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(600);
  });

  it("mélange sans perdre ni dupliquer d'élément, sans modifier l'original", () => {
    const rng = createRng("mélange");
    const items = Array.from({ length: 20 }, (_, i) => i);
    const shuffled = rng.shuffle(items);
    expect(shuffled).not.toEqual(items);
    expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
    expect(items[0]).toBe(0);
  });

  it("refuse les entrées absurdes", () => {
    const rng = createRng("erreurs");
    expect(() => rng.pick([])).toThrow(RangeError);
    expect(() => rng.int(5, 1)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
  });

  it("dérive un état 128 bits d'une graine texte et tire des graines aléatoires", () => {
    const state = seedFromString("abc");
    expect(state).toHaveLength(4);
    for (const n of state) expect(n).toBeGreaterThanOrEqual(0);
    expect(randomSeed()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSeed()).not.toBe(randomSeed());
  });
});
