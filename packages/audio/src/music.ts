/**
 * Musique générative (reprise de DCDS) : cinq ambiances jouées en boucle par un séquenceur
 * calé sur l'horloge audio. Un jeu peut ajouter ses propres ambiances (`createAudioEngine`).
 *
 * Chaque ambiance est une fonction appelée à chaque double-croche (`step` de 0 à 15) d'une
 * mesure (`bar`) : elle joue les notes qui tombent sur ce pas. Le hasard (`rnd`) apporte de
 * petites variations, pour que la boucle ne lasse pas.
 */

import {
  bass,
  bell,
  brass,
  clap,
  ep,
  hat,
  kick,
  type Kit,
  lead,
  marimba,
  pad,
  pluck,
  shaker,
  snare,
  woodblock,
} from "./synth.js";

/** Ambiances fournies, à choisir selon la phase de jeu. */
export type BuiltinMood = "lobby" | "game" | "suspense" | "reveal" | "victory";

export interface MoodDef {
  /** Tempo, en noires par minute. */
  bpm: number;
  /** Niveau relatif de l'ambiance. */
  level: number;
  step(kit: Kit, bar: number, step: number, t: number, sd: number, rnd: () => number): void;
}

/** Élément `i` d'une table de notes, en bouclant (les tables sont parcourues en cycle). */
function at<T>(list: readonly T[], i: number): T {
  return list[((Math.floor(i) % list.length) + list.length) % list.length]!;
}

const PENTA = [72, 74, 76, 79, 81, 84];

// Thème principal : bondissant, marimba + basse + petites percus (Do – Lam – Fa – Sol).
const GAME_CHORDS = [
  [60, 64, 67, 72],
  [57, 60, 64, 69],
  [53, 57, 60, 65],
  [55, 59, 62, 67],
];
const GAME_BASS = [36, 33, 41, 43];
const GAME_ARP = [0, 2, 1, 3, 2, 1, 3, 2];
const GAME_MELODY: [number, number, number][][] = [
  [
    [0, 76, 2],
    [2, 79, 2],
    [4, 81, 4],
    [10, 79, 2],
    [12, 76, 4],
  ],
  [
    [0, 76, 2],
    [2, 74, 2],
    [4, 72, 6],
    [12, 74, 4],
  ],
  [
    [0, 72, 2],
    [2, 74, 2],
    [4, 76, 4],
    [8, 79, 4],
    [12, 77, 4],
  ],
  [
    [0, 79, 6],
    [8, 76, 2],
    [10, 74, 2],
    [12, 74, 4],
  ],
];

// Salon : lounge doux (Fa7M – Mim7 – Rém7 – Do7M).
const LOBBY_CHORDS = [
  [53, 57, 60, 64],
  [52, 55, 59, 62],
  [50, 53, 57, 60],
  [48, 52, 55, 59],
];
const LOBBY_BASS = [41, 40, 38, 36];

// Suspense : ostinato en La mineur, tic-tac d'horloge, cœur qui bat.
const SUSPENSE_CHORDS = [
  [45, 48, 52],
  [45, 48, 52],
  [41, 45, 48],
  [40, 44, 47],
];

const VICTORY_CHORDS = [
  [60, 64, 67],
  [53, 57, 60],
  [55, 59, 62],
  [60, 64, 67],
];

export const MOODS: Record<BuiltinMood, MoodDef> = {
  lobby: {
    bpm: 88,
    level: 0.85,
    step(k, bar, s, t, sd, rnd) {
      const ci = bar % 4;
      const chord = at(LOBBY_CHORDS, ci);
      if (s === 0) chord.forEach((m) => ep(k, t, m, 0.075, sd * 14));
      if ((s === 6 || s === 10) && rnd() < 0.8) chord.slice(1).forEach((m) => ep(k, t, m + 12, 0.04, sd * 3));
      if (s === 0) bass(k, t, at(LOBBY_BASS, ci), 0.32, sd * 6);
      if (s === 10) bass(k, t, at(LOBBY_BASS, ci) + 7, 0.22, sd * 3);
      if (s === 14 && rnd() < 0.5) bass(k, t, at(LOBBY_BASS, ci) + 12, 0.15, sd * 2);
      if (s === 0) kick(k, t, 0.28);
      if (s === 10 && rnd() < 0.6) kick(k, t, 0.16);
      if (s === 4 || s === 12) snare(k, t, 0.05, 0.12, 2600);
      if (s % 4 === 2) hat(k, t, 0.025);
      if (s % 2 === 0 && rnd() < 0.07) bell(k, t, at(PENTA, rnd() * PENTA.length), 0.045, 1.4);
    },
  },

  game: {
    bpm: 112,
    level: 0.75,
    step(k, bar, s, t, sd, rnd) {
      const ci = bar % 4;
      const chord = at(GAME_CHORDS, ci);
      const root = at(GAME_BASS, ci);
      if (s === 0 || s === 8) kick(k, t, 0.42);
      if (ci === 3 && s === 14) kick(k, t, 0.25);
      if (s === 4 || s === 12) clap(k, t, 0.12);
      if (s % 2 === 1) shaker(k, t, s % 4 === 3 ? 0.045 : 0.025);
      if (s === 0) bass(k, t, root, 0.36, sd * 5);
      if (s === 6) bass(k, t, root + 7, 0.24, sd * 2);
      if (s === 8) bass(k, t, root + 12, 0.26, sd * 3);
      if (s === 14) bass(k, t, root + 7, 0.2, sd * 2);
      if (s % 2 === 0) marimba(k, t, at(chord, at(GAME_ARP, s / 2)), s % 4 === 0 ? 0.17 : 0.11);
      if (s % 2 === 1 && rnd() < 0.07) marimba(k, t, at(chord, rnd() * 4) + 12, 0.07);
      // Mélodie une phrase sur deux, pour respirer.
      if (Math.floor(bar / 4) % 2 === 1) {
        for (const [when, midi, len] of at(GAME_MELODY, ci)) if (when === s) lead(k, t, midi, len * sd, 0.07);
      }
      if (ci === 3 && s >= 12 && rnd() < 0.5) snare(k, t, 0.06, 0.06);
    },
  },

  suspense: {
    bpm: 84,
    level: 0.8,
    step(k, bar, s, t, sd, rnd) {
      const ci = bar % 4;
      const chord = at(SUSPENSE_CHORDS, ci);
      if (s % 2 === 0) pluck(k, t, at(chord, at([0, 1, 2, 1], s / 2)) + 12, 0.11);
      if (s % 4 === 0) woodblock(k, t, s === 0 ? 0.07 : 0.045, s === 0 ? 1100 : 1300);
      if (s === 0) kick(k, t, 0.34);
      if (s === 3) kick(k, t, 0.2);
      if (s === 0)
        pad(
          k,
          t,
          chord.map((m) => m + 12),
          sd * 15,
          0.022,
          700,
        );
      if (s === 0) bass(k, t, at(chord, 0) - 12, 0.22, sd * 12);
      if (ci === 0 && s === 0 && rnd() < 0.6) bell(k, t, 88, 0.035, 2.4);
    },
  },

  reveal: {
    bpm: 66,
    level: 0.6,
    step(k, bar, s, t, sd) {
      if (s === 0) kick(k, t, 0.32);
      if (s === 2) kick(k, t, 0.18);
      if (s === 8) kick(k, t, 0.26);
      if (s === 10) kick(k, t, 0.14);
      if (s % 4 === 0) hat(k, t, 0.018, 0.05);
      if (s === 0 && bar % 2 === 0) pad(k, t, [57, 64], sd * 30, 0.02, 600);
    },
  },

  victory: {
    bpm: 124,
    level: 0.85,
    step(k, bar, s, t, sd, rnd) {
      const ci = bar % 4;
      const chord = at(VICTORY_CHORDS, ci);
      if (s % 4 === 0) kick(k, t, 0.42);
      if (s === 4 || s === 12) clap(k, t, 0.14);
      if (s % 2 === 1) hat(k, t, 0.03);
      if (s === 0 || s === 3 || s === 6 || s === 10) chord.forEach((m) => brass(k, t, m, sd * 1.5, 0.045));
      if (s === 0) bass(k, t, at(chord, 0) - 24, 0.34, sd * 4);
      if (s === 8) bass(k, t, at(chord, 0) - 12, 0.26, sd * 3);
      marimba(k, t, at(chord, s) + 12, s % 4 === 0 ? 0.12 : 0.07);
      if (s === 0 && rnd() < 0.7) bell(k, t, 84 + at(chord, 0) - 60, 0.05, 1.5);
    },
  },
};

/**
 * Séquenceur à « tête de lecture anticipée » : il planifie les notes ~120 ms à l'avance
 * sur l'horloge audio, pour un tempo parfaitement stable même si le fil JavaScript est
 * occupé. Un changement d'ambiance attend la mesure suivante, pour rester en rythme.
 */
export class MusicSequencer {
  private mood: string | null = null;
  private pending: string | null = null;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly kit: Kit;
  private readonly moods: Readonly<Record<string, MoodDef>>;
  private readonly onMoodLevel: (level: number) => void;

  constructor(kit: Kit, moods: Readonly<Record<string, MoodDef>>, onMoodLevel: (level: number) => void) {
    this.kit = kit;
    this.moods = moods;
    this.onMoodLevel = onMoodLevel;
  }

  /** Ambiance en cours (ou à venir à la prochaine mesure). */
  get current(): string | null {
    return this.pending ?? this.mood;
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  setMood(mood: string | null): void {
    if (mood !== null && !this.moods[mood]) return;
    if (mood === this.current) return;
    if (!this.mood || !mood) {
      // Démarrage ou arrêt : immédiat.
      this.mood = mood;
      this.pending = null;
      this.bar = 0;
      this.step = 0;
      this.nextTime = this.kit.ctx.currentTime + 0.05;
      if (mood) this.onMoodLevel(this.moods[mood]!.level);
      return;
    }
    // Changement d'ambiance : à la prochaine mesure, pour rester en rythme.
    this.pending = mood;
  }

  start(): void {
    if (this.timer) return;
    this.nextTime = Math.max(this.nextTime, this.kit.ctx.currentTime + 0.05);
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Planifie les pas qui tombent dans les ~120 ms à venir (appelé toutes les 25 ms). */
  tick(): void {
    const ctx = this.kit.ctx;
    if (!this.mood) return;
    // Onglet resté en arrière-plan : on se recale au lieu de rattraper.
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + 0.12) {
      if (this.step === 0 && this.pending) {
        this.mood = this.pending;
        this.pending = null;
        this.bar = 0;
        this.onMoodLevel(this.moods[this.mood]!.level);
      }
      const def = this.moods[this.mood]!;
      const sd = 60 / def.bpm / 4;
      def.step(this.kit, this.bar, this.step, this.nextTime, sd, Math.random);
      this.nextTime += sd;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar += 1;
    }
  }
}
