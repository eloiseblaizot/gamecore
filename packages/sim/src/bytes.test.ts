import { describe, expect, it } from "vitest";
import { ByteReader, ByteWriter } from "./bytes.js";

describe("ByteWriter / ByteReader", () => {
  it("relit exactement ce qui a été écrit, en agrandissant le tampon au besoin", () => {
    const cells = new Uint16Array(3000).map((_, i) => i * 7);
    const w = new ByteWriter(16);
    w.u8(255).u16(65535).u32(4_000_000_000).i32(-5).f64(Math.PI).bool(true).string("Héhé 🦊");
    w.typed(cells)
      .bytes(new Uint8Array([1, 2, 3]))
      .typed(new Float32Array([0.5, -2]));
    const bytes = w.finish();
    expect(bytes.length).toBe(w.length);

    const r = new ByteReader(bytes);
    expect([r.u8(), r.u16(), r.u32(), r.i32(), r.f64(), r.bool(), r.string()]).toEqual([
      255,
      65535,
      4_000_000_000,
      -5,
      Math.PI,
      true,
      "Héhé 🦊",
    ]);
    expect(r.uint16Array()).toEqual(cells);
    expect(r.bytesValue()).toEqual(new Uint8Array([1, 2, 3]));
    expect(Array.from(r.float32Array())).toEqual([0.5, -2]);
    expect(r.remaining).toBe(0);
  });

  it("couvre tous les types de tableaux", () => {
    const w = new ByteWriter();
    w.typed(new Int8Array([-1]))
      .typed(new Int16Array([-2]))
      .typed(new Uint32Array([3]));
    w.typed(new Int32Array([-4]))
      .typed(new Float64Array([5.5]))
      .typed(new Uint8Array([6]));
    const r = new ByteReader(w.finish());
    expect([
      r.int8Array()[0],
      r.int16Array()[0],
      r.uint32Array()[0],
      r.int32Array()[0],
      r.float64Array()[0],
    ]).toEqual([-1, -2, 3, -4, 5.5]);
    expect(r.uint8Array()[0]).toBe(6);
  });

  it("refuse une lecture au-delà de la fin (données tronquées ou falsifiées)", () => {
    const w = new ByteWriter();
    w.u32(1_000_000); // longueur annoncée mensongère
    const r = new ByteReader(w.finish());
    expect(() => r.bytesValue()).toThrow(RangeError);
    expect(() => new ByteReader(new Uint8Array(1)).u32()).toThrow(RangeError);
  });

  it("lit à travers une vue décalée", () => {
    const backing = new Uint8Array(10);
    backing.set(new ByteWriter().u16(513).finish(), 3);
    expect(new ByteReader(backing.subarray(3, 5)).u16()).toBe(513);
  });

  it("refuse une chaîne UTF-8 invalide", () => {
    const w = new ByteWriter();
    w.bytes(new Uint8Array([0xff, 0xfe]));
    expect(() => new ByteReader(w.finish()).string()).toThrow(RangeError);
  });
});
