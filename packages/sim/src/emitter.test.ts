import { describe, expect, it, vi } from "vitest";
import { Emitter } from "./emitter.js";

describe("Emitter", () => {
  it("prévient les écouteurs, se désabonne et se vide", () => {
    const emitter = new Emitter<{ a: [number]; b: [] }>();
    const seen: number[] = [];
    expect(emitter.has("a")).toBe(false);
    const off = emitter.on("a", (n) => seen.push(n));
    expect(emitter.has("a")).toBe(true);
    emitter.emit("a", 1);
    emitter.emit("b"); // personne n'écoute
    off();
    emitter.emit("a", 2);
    expect(seen).toEqual([1]);
    emitter.on("a", (n) => seen.push(n));
    emitter.clear();
    emitter.emit("a", 3);
    expect(seen).toEqual([1]);
  });

  it("isole un écouteur défaillant", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const emitter = new Emitter<{ a: [] }>();
    const calls: string[] = [];
    emitter.on("a", () => {
      throw new Error("raté");
    });
    emitter.on("a", () => calls.push("second"));
    emitter.emit("a");
    expect(calls).toEqual(["second"]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
