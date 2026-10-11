import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SOUND, createAudioEngine } from "./engine.js";
import { MOODS, MusicSequencer, type MoodDef } from "./music.js";
import { SFX } from "./sfx.js";
import { makeImpulse, makeNoise, type Kit } from "./synth.js";
import { FakeAudioContext } from "./testing.js";

function kit(ctx = new FakeAudioContext()): Kit {
  const real = ctx as unknown as AudioContext;
  const input = real.createGain();
  return { ctx: real, noise: makeNoise(real), bus: { input, send: input } };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bruitages", () => {
  it.each(Object.keys(SFX))("« %s » se joue sans erreur et programme des sons à partir de t", (name) => {
    const ctx = new FakeAudioContext();
    const k = kit(ctx);
    ctx.starts.length = 0;
    SFX[name as keyof typeof SFX](k, 10, { duration: 1, pitch: 1.2 });
    expect(ctx.starts.length).toBeGreaterThan(0);
    for (const s of ctx.starts) expect(s.time).toBeGreaterThanOrEqual(10);
  });

  it("fabrique bruit blanc et réverbération", () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const noise = makeNoise(ctx);
    expect(noise.length).toBe(ctx.sampleRate * 2);
    const impulse = makeImpulse(ctx, 1, 3);
    const data = impulse.getChannelData(0);
    expect(impulse.numberOfChannels).toBe(2);
    // La réverbération décroît : la fin est plus calme que le début.
    const energy = (from: number, to: number) => data.slice(from, to).reduce((a, x) => a + x * x, 0);
    expect(energy(0, 800)).toBeGreaterThan(energy(data.length - 800, data.length));
  });
});

describe("musique", () => {
  it.each(Object.keys(MOODS))("l'ambiance « %s » joue deux mesures sans erreur", (mood) => {
    const ctx = new FakeAudioContext();
    const def = MOODS[mood as keyof typeof MOODS];
    const k = kit(ctx);
    const sd = 60 / def.bpm / 4;
    for (let bar = 0; bar < 8; bar++)
      for (let step = 0; step < 16; step++) def.step(k, bar, step, bar * 16 * sd + step * sd, sd, () => 0.3);
    expect(ctx.starts.length).toBeGreaterThan(16);
  });

  it("planifie les notes en avance et change d'ambiance à la mesure suivante", () => {
    const ctx = new FakeAudioContext();
    const played: string[] = [];
    const make = (name: string): MoodDef => ({
      bpm: 120,
      level: 0.5,
      step: (_k, _bar, step) => step === 0 && played.push(name),
    });
    const levels: number[] = [];
    const seq = new MusicSequencer(kit(ctx), { a: make("a"), b: make("b") }, (l) => levels.push(l));
    seq.setMood("a");
    seq.start();
    expect(seq.playing).toBe(true);
    // Une mesure à 120 bpm = 2 s : on avance l'horloge audio par petits pas.
    for (let i = 0; i < 40; i++) {
      ctx.currentTime += 0.05;
      vi.advanceTimersByTime(25);
    }
    seq.setMood("b");
    expect(seq.current).toBe("b");
    for (let i = 0; i < 80; i++) {
      ctx.currentTime += 0.05;
      vi.advanceTimersByTime(25);
    }
    expect(played[0]).toBe("a");
    expect(played).toContain("b");
    expect(levels).toEqual([0.5, 0.5]);
    seq.stop();
    expect(seq.playing).toBe(false);
  });

  it("se recale après un passage en arrière-plan au lieu de rattraper le retard", () => {
    const ctx = new FakeAudioContext();
    let steps = 0;
    const seq = new MusicSequencer(kit(ctx), { a: { bpm: 120, level: 1, step: () => steps++ } }, () => {});
    seq.setMood("a");
    seq.tick();
    const before = steps;
    ctx.currentTime += 60; // une minute « gelée »
    seq.tick();
    expect(steps - before).toBeLessThan(5);
  });

  it("ignore une ambiance inconnue", () => {
    const seq = new MusicSequencer(kit(), MOODS, () => {});
    seq.setMood("inconnue");
    expect(seq.current).toBeNull();
  });
});

describe("moteur audio", () => {
  it("ne crée aucun contexte audio avant un geste de l'utilisateur", () => {
    const createContext = vi.fn(() => new FakeAudioContext() as unknown as AudioContext);
    const engine = createAudioEngine({ storageKey: "t", createContext, storage: null });
    engine.play("click");
    engine.setMood("game");
    expect(createContext).not.toHaveBeenCalled();
    expect(engine.unlocked).toBe(false);
    engine.unlock();
    engine.unlock();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(engine.unlocked).toBe(true);
  });

  it("réveille un contexte suspendu", () => {
    const ctx = new FakeAudioContext("suspended");
    const engine = createAudioEngine({ storageKey: "t", createContext: () => ctx as never, storage: null });
    engine.unlock();
    expect(ctx.state).toBe("running");
  });

  it("joue les bruitages seulement quand c'est permis", () => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine({ storageKey: "t", createContext: () => ctx as never, storage: null });
    engine.unlock();
    const count = () => ctx.starts.length;
    let before = count();
    engine.play("success");
    expect(count()).toBeGreaterThan(before);
    for (const block of [
      () => engine.setSettings({ muted: true }),
      () => engine.setSettings({ muted: false, sfx: 0 }),
      () => {
        engine.setSettings({ sfx: 0.8 });
        engine.setHidden(true);
      },
    ]) {
      block();
      before = count();
      engine.play("success");
      expect(count()).toBe(before);
    }
  });

  it("mémorise des réglages bornés et ignore un stockage corrompu", () => {
    const storage = memoryStorage({ t: "{pas du json" });
    const engine = createAudioEngine({ storageKey: "t", storage });
    expect(engine.getSettings()).toEqual(DEFAULT_SOUND);
    engine.setSettings({ music: 7, sfx: -1 });
    expect(engine.getSettings()).toEqual({ music: 1, sfx: 0, muted: false });
    engine.toggleMute();
    expect(JSON.parse(storage.data.get("t")!)).toEqual({ music: 1, sfx: 0, muted: true });
    const again = createAudioEngine({ storageKey: "t", storage });
    expect(again.getSettings().muted).toBe(true);
  });

  it("prévient les abonnés quand les réglages changent", () => {
    const engine = createAudioEngine({ storageKey: "t", storage: null });
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    engine.setSettings({ music: 0.5 });
    unsubscribe();
    engine.setSettings({ music: 0.6 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lance la musique seulement si une ambiance est choisie et le son actif", () => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine({ storageKey: "t", createContext: () => ctx as never, storage: null });
    engine.setMood("lobby");
    engine.unlock();
    expect(engine.currentMood).toBe("lobby");
    const tick = () => {
      ctx.currentTime += 0.5;
      vi.advanceTimersByTime(500);
    };
    let before = ctx.starts.length;
    tick();
    expect(ctx.starts.length).toBeGreaterThan(before);
    engine.setSettings({ muted: true });
    before = ctx.starts.length;
    tick();
    expect(ctx.starts.length).toBe(before);
    engine.setSettings({ muted: false });
    engine.setMood(null);
    before = ctx.starts.length;
    tick();
    expect(ctx.starts.length).toBe(before);
  });

  it("accepte les bruitages et ambiances propres au jeu", () => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine({
      storageKey: "t",
      createContext: () => ctx as never,
      storage: null,
      sfx: { boing: (k, t) => SFX.pop(k, t) },
      moods: { calme: { bpm: 60, level: 0.3, step: () => {} } },
    });
    engine.unlock();
    const before = ctx.starts.length;
    engine.play("boing");
    expect(ctx.starts.length).toBeGreaterThan(before);
    engine.setMood("calme");
    expect(engine.currentMood).toBe("calme");
  });

  it("baisse la musique quand quelqu'un parle, puis la remonte", () => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine({ storageKey: "t", createContext: () => ctx as never, storage: null });
    engine.setDuck(true); // sans contexte : sans effet
    engine.unlock();
    engine.setDuck(true);
    const targets = () =>
      ctx.nodes
        .filter((n) => n.kind === "gain")
        .flatMap((n) => (n as unknown as { gain: { events: { type: string; value: number }[] } }).gain.events)
        .filter((e) => e.type === "target")
        .map((e) => e.value);
    expect(targets()).toContain(0.35);
    engine.setDuck(false);
    vi.advanceTimersByTime(700);
    expect(targets().at(-1)).toBe(1);
  });

  it("se ferme proprement", () => {
    const ctx = new FakeAudioContext();
    const engine = createAudioEngine({ storageKey: "t", createContext: () => ctx as never, storage: null });
    engine.unlock();
    engine.close();
    expect(ctx.state).toBe("closed");
    expect(engine.unlocked).toBe(false);
  });

  it("reste muet sans Web Audio (navigateur ancien, serveur)", () => {
    const engine = createAudioEngine({ storageKey: "t", createContext: () => null, storage: null });
    engine.unlock();
    engine.play("click");
    expect(engine.unlocked).toBe(false);
  });
});
