// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioEngine } from "./engine.js";
import { AudioProvider, SoundControls, useMusicMood, useSfx } from "./react.js";
import { FakeAudioContext } from "./testing.js";

afterEach(cleanup);

function setup() {
  const ctx = new FakeAudioContext();
  const createContext = vi.fn(() => ctx as unknown as AudioContext);
  const engine = createAudioEngine({ storageKey: "test", createContext, storage: null });
  return { ctx, engine, createContext };
}

describe("AudioProvider", () => {
  it("débloque le son au premier geste, pas avant", () => {
    const { engine, createContext } = setup();
    render(
      <AudioProvider engine={engine}>
        <p>jeu</p>
      </AudioProvider>,
    );
    expect(createContext).not.toHaveBeenCalled();
    fireEvent.pointerDown(window);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(engine.unlocked).toBe(true);
  });

  it("coupe le son avec la touche M, sauf pendant une saisie", () => {
    const { engine } = setup();
    render(
      <AudioProvider engine={engine}>
        <input aria-label="pseudo" />
      </AudioProvider>,
    );
    fireEvent.keyDown(window, { key: "m" });
    expect(engine.getSettings().muted).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("pseudo"), { key: "m" });
    expect(engine.getSettings().muted).toBe(true);
    fireEvent.keyDown(window, { key: "M", ctrlKey: true });
    expect(engine.getSettings().muted).toBe(true);
    fireEvent.keyDown(window, { key: "M" });
    expect(engine.getSettings().muted).toBe(false);
  });

  it("joue un clic sur les éléments choisis", () => {
    const { engine, ctx } = setup();
    render(
      <AudioProvider engine={engine} clickSelector="button">
        <button>OK</button>
        <button disabled>Non</button>
      </AudioProvider>,
    );
    fireEvent.pointerDown(window);
    const before = ctx.starts.length;
    fireEvent.click(screen.getByText("OK"));
    expect(ctx.starts.length).toBeGreaterThan(before);
    const after = ctx.starts.length;
    fireEvent.click(screen.getByText("Non"));
    expect(ctx.starts.length).toBe(after);
  });

  it("se tait quand l'onglet passe en arrière-plan", () => {
    const { engine } = setup();
    const spy = vi.spyOn(engine, "setHidden");
    render(<AudioProvider engine={engine}>x</AudioProvider>);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(spy).toHaveBeenLastCalledWith(true);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
});

describe("hooks", () => {
  it("useMusicMood choisit l'ambiance et l'arrête au démontage", () => {
    const { engine } = setup();
    function Page({ mood }: { mood: "lobby" | "game" }) {
      useMusicMood(mood);
      return null;
    }
    const { rerender, unmount } = render(
      <AudioProvider engine={engine}>
        <Page mood="lobby" />
      </AudioProvider>,
    );
    expect(engine.currentMood).toBe("lobby");
    rerender(
      <AudioProvider engine={engine}>
        <Page mood="game" />
      </AudioProvider>,
    );
    expect(engine.currentMood).toBe("game");
    unmount();
    expect(engine.currentMood).toBeNull();
  });

  it("useSfx joue un bruitage", () => {
    const { engine, ctx } = setup();
    let play!: ReturnType<typeof useSfx>;
    function Button() {
      play = useSfx();
      return null;
    }
    render(
      <AudioProvider engine={engine}>
        <Button />
      </AudioProvider>,
    );
    engine.unlock();
    const before = ctx.starts.length;
    act(() => play("success"));
    expect(ctx.starts.length).toBeGreaterThan(before);
  });

  it("exigent un AudioProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Orphan() {
      useSfx();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/AudioProvider/);
  });
});

describe("SoundControls", () => {
  it("ouvre les réglages, règle les volumes et coupe le son", () => {
    const { engine } = setup();
    render(
      <AudioProvider engine={engine}>
        <SoundControls />
      </AudioProvider>,
    );
    const toggle = screen.getByRole("button", { name: "Réglages du son" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByLabelText("🎵 Musique"), { target: { value: "60" } });
    expect(engine.getSettings().music).toBe(0.6);
    fireEvent.change(screen.getByLabelText("✨ Effets"), { target: { value: "0" } });
    expect(engine.getSettings().sfx).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "🔇 Tout couper" }));
    expect(screen.getByRole("button", { name: "Son coupé : ouvrir les réglages du son" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Réglages du son" })).toBeNull();
  });
});
