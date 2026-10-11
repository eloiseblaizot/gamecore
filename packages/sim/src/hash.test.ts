import { describe, expect, it } from "vitest";
import { fnv1a64, hashState } from "./hash.js";

const text = (s: string) => new TextEncoder().encode(s);

describe("fnv1a64", () => {
  it("respecte les vecteurs officiels FNV-1a 64 bits", () => {
    expect(fnv1a64(text(""))).toBe("cbf29ce484222325");
    expect(fnv1a64(text("a"))).toBe("af63dc4c8601ec8c");
    expect(fnv1a64(text("foobar"))).toBe("85944171f73967e8");
  });
});

describe("hashState", () => {
  it("est stable et sensible au moindre changement", () => {
    const state = {
      tick: 3,
      cells: new Uint8Array([1, 2, 3]),
      names: ["a", "b"],
      nested: { x: 1.5, y: null },
    };
    const h = hashState(state);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashState(structuredClone(state))).toBe(h);
    const changed = structuredClone(state);
    changed.cells[2] = 4;
    expect(hashState(changed)).not.toBe(h);
  });

  it("ignore l'ordre de construction des objets simples, pas celui des Map et des Set", () => {
    expect(hashState({ a: 1, b: 2 })).toBe(hashState({ b: 2, a: 1 }));
    expect(
      hashState(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).not.toBe(
      hashState(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    );
    expect(hashState(new Set([1, 2]))).not.toBe(hashState(new Set([2, 1])));
    expect(hashState([1, 2])).not.toBe(hashState([2, 1]));
  });

  it("distingue les types", () => {
    const hashes = [
      hashState(1),
      hashState("1"),
      hashState([1]),
      hashState(true),
      hashState(null),
      hashState(undefined),
      hashState(1n),
      hashState({}),
      hashState(new Map()),
      hashState(new Set()),
      hashState(new Uint8Array([1])),
      hashState(new Int8Array([1])),
      hashState(new Uint8Array([1]).buffer),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("hache les octets réels d'une vue, pas tout son tampon", () => {
    const buffer = new Uint8Array([9, 1, 2, 9]);
    expect(hashState(buffer.subarray(1, 3))).toBe(hashState(new Uint8Array([1, 2])));
    expect(hashState(new DataView(buffer.buffer, 1, 2))).not.toBe(hashState(new Uint8Array([1, 2])));
  });

  it("normalise NaN et accepte les références partagées", () => {
    expect(hashState(Number.NaN)).toBe(hashState(0 / 0));
    const shared = { x: 1 };
    expect(() => hashState([shared, shared])).not.toThrow();
  });

  it("refuse ce qui n'est pas un état (fonction, symbole, cycle, Date…)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hashState({ f: () => 1 })).toThrow(/fonction/);
    expect(() => hashState(Symbol("x"))).toThrow(/symbole/);
    expect(() => hashState(cyclic)).toThrow(/cyclique/);
    expect(() => hashState(new Date(0))).toThrow(/Date/);
    expect(() => hashState({ r: /a/ })).toThrow(/RegExp/);
  });
});
