/**
 * Moteur audio d'un jeu (repris de DCDS et rendu générique).
 *
 *   export const audio = createAudioEngine({ storageKey: "buzzer-audio" });
 *   audio.unlock();              // au premier geste de l'utilisateur
 *   audio.play("success");       // bruitage
 *   audio.setMood("game");       // ambiance musicale (null : silence)
 *
 * Règles respectées :
 *   - aucun son avant une interaction (les navigateurs l'interdisent de toute façon) ;
 *   - volumes musique / effets séparés, mémorisés, coupure générale (touche M via le
 *     fournisseur React) ;
 *   - silence quand l'onglet est en arrière-plan ;
 *   - la musique baisse automatiquement quand quelqu'un parle (`setDuck`, branché sur la
 *     détection de parole de LiveKit).
 */

import { MOODS, MusicSequencer, type BuiltinMood, type MoodDef } from "./music.js";
import { SFX, type SfxName, type SfxOptions, type SfxRecipe } from "./sfx.js";
import { makeImpulse, makeNoise, type Kit } from "./synth.js";

export interface SoundSettings {
  /** Volume de la musique, de 0 à 1. */
  music: number;
  /** Volume des effets, de 0 à 1. */
  sfx: number;
  muted: boolean;
}

export const DEFAULT_SOUND: SoundSettings = { music: 0.35, sfx: 0.8, muted: false };

/** Atténuation de la musique pendant que quelqu'un parle au micro. */
const DUCK_LEVEL = 0.35;

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  musicGain: GainNode;
  duck: GainNode;
  sfxGain: GainNode;
  sfxKit: Kit;
  sequencer: MusicSequencer;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export interface AudioEngineOptions<CustomSfx extends string, CustomMood extends string> {
  /** Clé de mémorisation des réglages (propre à chaque jeu). */
  storageKey: string;
  /** Bruitages propres au jeu, ajoutés à la bibliothèque générique. */
  sfx?: Record<CustomSfx, SfxRecipe>;
  /** Ambiances propres au jeu, ajoutées aux ambiances fournies. */
  moods?: Record<CustomMood, MoodDef>;
  /** Fabrique du contexte audio (tests) ; par défaut `new AudioContext()`. */
  createContext?: () => AudioContext | null;
  /** Stockage des réglages (tests) ; par défaut `localStorage` s'il est disponible. */
  storage?: Storage | null;
}

function makeBus(ctx: AudioContext, impulse: AudioBuffer, destination: AudioNode, wet: number) {
  const input = ctx.createGain();
  const send = ctx.createGain();
  const verb = ctx.createConvolver();
  const ret = ctx.createGain();
  verb.buffer = impulse;
  ret.gain.value = wet;
  input.connect(destination);
  send.connect(verb).connect(ret).connect(destination);
  return { input, send };
}

function defaultContext(): AudioContext | null {
  const Ctor =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: "interactive" }) : null;
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const clamp01 = (n: unknown, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;

export class AudioEngine<CustomSfx extends string = never, CustomMood extends string = never> {
  private graph: Graph | null = null;
  private settings: SoundSettings | null = null;
  private readonly listeners = new Set<() => void>();
  private mood: BuiltinMood | CustomMood | null = null;
  private moodLevel = 1;
  private hidden = false;
  private duckTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly recipes: Record<string, SfxRecipe>;
  private readonly moods: Record<string, MoodDef>;
  private readonly options: AudioEngineOptions<CustomSfx, CustomMood>;

  constructor(options: AudioEngineOptions<CustomSfx, CustomMood>) {
    this.options = options;
    this.recipes = { ...SFX, ...options.sfx };
    this.moods = { ...MOODS, ...options.moods };
  }

  // --- Réglages ---------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Réglages courants (lus une fois dans le stockage, valeurs bornées). */
  getSettings = (): SoundSettings => {
    if (!this.settings) {
      let saved: Partial<SoundSettings> = {};
      try {
        const raw = this.storage()?.getItem(this.options.storageKey);
        if (raw) saved = JSON.parse(raw) as Partial<SoundSettings>;
      } catch {
        // Stockage indisponible ou valeur corrompue : réglages par défaut.
      }
      this.settings = {
        music: clamp01(saved.music, DEFAULT_SOUND.music),
        sfx: clamp01(saved.sfx, DEFAULT_SOUND.sfx),
        muted: typeof saved.muted === "boolean" ? saved.muted : DEFAULT_SOUND.muted,
      };
    }
    return this.settings;
  };

  setSettings(patch: Partial<SoundSettings>): void {
    const current = this.getSettings();
    this.settings = {
      music: clamp01(patch.music, current.music),
      sfx: clamp01(patch.sfx, current.sfx),
      muted: typeof patch.muted === "boolean" ? patch.muted : current.muted,
    };
    try {
      this.storage()?.setItem(this.options.storageKey, JSON.stringify(this.settings));
    } catch {
      // Stockage plein ou interdit : réglage valable pour cette page seulement.
    }
    this.applyLevels();
    this.updateSequencer();
    for (const listener of [...this.listeners]) listener();
  }

  toggleMute(): void {
    this.setSettings({ muted: !this.getSettings().muted });
  }

  // --- Cycle de vie -------------------------------------------------------------------

  /** À appeler sur un geste de l'utilisateur : crée (ou réveille) le contexte audio. */
  unlock(): void {
    if (!this.graph) {
      const ctx = (this.options.createContext ?? defaultContext)();
      if (!ctx) return;
      // Limiteur en bout de chaîne : jamais de saturation, même avec beaucoup de sons.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      limiter.connect(ctx.destination);
      const master = ctx.createGain();
      master.connect(limiter);
      const duck = ctx.createGain();
      duck.connect(master);
      const musicGain = ctx.createGain();
      musicGain.connect(duck);
      const sfxGain = ctx.createGain();
      sfxGain.connect(master);
      const impulse = makeImpulse(ctx, 2.2, 3);
      const noise = makeNoise(ctx);
      const musicKit: Kit = { ctx, noise, bus: makeBus(ctx, impulse, musicGain, 0.22) };
      const sfxKit: Kit = { ctx, noise, bus: makeBus(ctx, impulse, sfxGain, 0.28) };
      const sequencer = new MusicSequencer(musicKit, this.moods, (level) => {
        this.moodLevel = level;
        this.applyLevels();
      });
      this.graph = { ctx, master, musicGain, duck, sfxGain, sfxKit, sequencer };
      this.applyLevels(true);
      if (this.mood) sequencer.setMood(this.mood);
    }
    if (this.graph.ctx.state === "suspended") void this.graph.ctx.resume();
    this.updateSequencer();
  }

  /** Le son est-il actif (contexte créé et en marche) ? */
  get unlocked(): boolean {
    return this.graph?.ctx.state === "running";
  }

  /** Onglet en arrière-plan : on se tait. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.updateSequencer();
  }

  /** Libère le contexte audio (fin de page, tests). */
  close(): void {
    this.graph?.sequencer.stop();
    void this.graph?.ctx.close();
    this.graph = null;
  }

  // --- Sons ---------------------------------------------------------------------------

  /** Joue un bruitage (silencieux tant que le son n'est pas débloqué, coupé ou masqué). */
  play(name: SfxName | CustomSfx, options: SfxOptions & { delay?: number } = {}): void {
    const g = this.graph;
    const s = this.getSettings();
    if (!g || g.ctx.state !== "running" || s.muted || s.sfx <= 0 || this.hidden) return;
    const recipe = this.recipes[name];
    if (!recipe) return;
    try {
      recipe(g.sfxKit, g.ctx.currentTime + 0.01 + Math.max(0, options.delay ?? 0), options);
    } catch (err) {
      console.warn("[gamecore/audio]", err);
    }
  }

  /** Ambiance musicale (`null` : pas de musique). */
  setMood(mood: BuiltinMood | CustomMood | null): void {
    if (mood !== null && !this.moods[mood]) return;
    this.mood = mood;
    this.graph?.sequencer.setMood(mood);
    this.updateSequencer();
  }

  get currentMood(): BuiltinMood | CustomMood | null {
    return this.mood;
  }

  /** Baisse la musique pendant que quelqu'un parle (micros) ; remonte 0,7 s après. */
  setDuck(on: boolean): void {
    const g = this.graph;
    if (!g) return;
    if (this.duckTimer) clearTimeout(this.duckTimer);
    this.duckTimer = null;
    const apply = (level: number) => g.duck.gain.setTargetAtTime(level, g.ctx.currentTime, 0.15);
    if (on) apply(DUCK_LEVEL);
    else this.duckTimer = setTimeout(() => apply(1), 700);
  }

  // --- Interne ------------------------------------------------------------------------

  private storage(): Storage | null {
    return this.options.storage === undefined ? defaultStorage() : this.options.storage;
  }

  private applyLevels(immediate = false): void {
    const g = this.graph;
    if (!g) return;
    const s = this.getSettings();
    const now = g.ctx.currentTime;
    const set = (p: AudioParam, v: number) =>
      immediate ? p.setValueAtTime(v, now) : p.setTargetAtTime(v, now, 0.08);
    set(g.master.gain, s.muted ? 0 : 1);
    // Courbe quadratique : le curseur paraît plus naturel à l'oreille.
    set(g.musicGain.gain, s.music * s.music * this.moodLevel);
    set(g.sfxGain.gain, s.sfx * s.sfx);
  }

  private updateSequencer(): void {
    const g = this.graph;
    if (!g) return;
    const s = this.getSettings();
    const shouldPlay = !!this.mood && !s.muted && s.music > 0 && !this.hidden && g.ctx.state !== "closed";
    if (shouldPlay) g.sequencer.start();
    else g.sequencer.stop();
  }
}

/** Crée le moteur audio d'un jeu. */
export function createAudioEngine<CustomSfx extends string = never, CustomMood extends string = never>(
  options: AudioEngineOptions<CustomSfx, CustomMood>,
): AudioEngine<CustomSfx, CustomMood> {
  return new AudioEngine(options);
}
