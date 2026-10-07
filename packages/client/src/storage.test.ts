// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { browserSessionStore, memoryStore, readSession } from "./storage.js";

describe("stockage de session", () => {
  it("utilise sessionStorage quand il est disponible", () => {
    const store = browserSessionStore();
    expect(store).not.toBeNull();
    store!.set("k", "v");
    expect(sessionStorage.getItem("k")).toBe("v");
    expect(store!.get("k")).toBe("v");
    store!.remove("k");
    expect(store!.get("k")).toBeNull();
  });

  it("renonce proprement si le stockage est interdit (iframe, navigation privée stricte)", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("refusé", "SecurityError");
      },
      removeItem: () => undefined,
    });
    expect(browserSessionStore()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("ignore une session corrompue ou falsifiée", () => {
    const store = memoryStore();
    for (const bad of [
      "{pas du json",
      "42",
      JSON.stringify({ code: 1 }),
      JSON.stringify({ code: "A", kind: "x", token: 5 }),
    ]) {
      store.set("s", bad);
      expect(readSession(store, "s")).toBeNull();
    }
    store.set("s", JSON.stringify({ code: "ABCDEF", kind: "screen", token: null }));
    expect(readSession(store, "s")).toEqual({ code: "ABCDEF", kind: "screen", token: null });
    expect(readSession(null, "s")).toBeNull();
  });
});
