/**
 * Bruitages génériques, construits avec les instruments de `synth.ts` (repris de DCDS et
 * rendus indépendants du jeu). Un jeu peut en ajouter (voir `createAudioEngine`).
 *
 * ⚠️ Secret et micros : un son joué chez un joueur passe aussi dans son micro (vocal Discord,
 * stream). Un son qui dépend d'une information secrète (« ton lot est génial ») la trahirait :
 * pour un évènement privé, utilise un son NEUTRE et réserve les sons expressifs aux
 * évènements publics (révélation, fin de manche).
 */

import {
  applause,
  bass,
  bell,
  blip,
  brass,
  buzzer,
  choir,
  crash,
  creak,
  drumroll,
  hat,
  kick,
  marimba,
  pad,
  siren,
  snare,
  timpani,
  trombone,
  whoosh,
  woodblock,
  type Kit,
} from "./synth.js";

export interface SfxOptions {
  /** Durée (roulement de tambour, applaudissements…), en secondes. */
  duration?: number;
  /** Hauteur relative (1 = normale), pour varier un tic ou un clic. */
  pitch?: number;
}

/** Une recette de bruitage : joue des notes à partir de la date `t` (horloge audio). */
export type SfxRecipe = (kit: Kit, t: number, options: SfxOptions) => void;

const fanfare = (kit: Kit, t: number, notes: [number, number, number][], vel = 0.16) => {
  for (const [dt, midi, dur] of notes) brass(kit, t + dt, midi, dur, vel);
};

const sparkle = (kit: Kit, t: number, notes: number[], gap = 0.07, vel = 0.07) => {
  notes.forEach((m, i) => bell(kit, t + i * gap, m, vel, 1.2));
};

export const SFX = {
  // --- Interface ------------------------------------------------------------
  /** Clic de bouton. */
  click: (k, t, o) => blip(k, t, 520 * (o.pitch ?? 1), 760 * (o.pitch ?? 1), 0.045, 0.07),
  /** Petit « pop » (apparition, réaction). */
  pop: (k, t) => {
    blip(k, t, 280, 640, 0.05, 0.18);
    hat(k, t, 0.03, 0.02);
  },
  /** Un joueur arrive. */
  join: (k, t) => {
    blip(k, t, 300, 700, 0.05, 0.16);
    blip(k, t + 0.08, 450, 1000, 0.05, 0.14);
  },
  /** Un joueur part. */
  leave: (k, t) => {
    blip(k, t, 700, 300, 0.06, 0.12);
    blip(k, t + 0.08, 500, 220, 0.06, 0.1);
  },
  /** Message de chat. */
  chat: (k, t) => blip(k, t, 880, 1180, 0.035, 0.06),
  /** Action refusée. */
  error: (k, t) => {
    blip(k, t, 240, 140, 0.14, 0.25);
    blip(k, t + 0.02, 120, 80, 0.12, 0.1, "square");
  },
  /** Transition, changement d'écran. */
  whoosh: (k, t) => whoosh(k, t, 0.3, 500, 2500, 0.08),

  // --- Déroulé de la partie -----------------------------------------------------
  /** Lancement de la partie. */
  start: (k, t) => {
    crash(k, t, 0.18);
    kick(k, t, 0.5);
    fanfare(k, t, [
      [0, 60, 0.12],
      [0.13, 64, 0.12],
      [0.26, 67, 0.12],
      [0.39, 72, 0.7],
    ]);
  },
  /** Nouvelle manche, nouvelle question. */
  round: (k, t) => {
    whoosh(k, t, 0.5, 300, 2800, 0.1);
    bell(k, t + 0.35, 76, 0.18);
    bell(k, t + 0.5, 83, 0.15);
  },
  /** C'est à toi de jouer. */
  myTurn: (k, t) => {
    whoosh(k, t, 0.3, 500, 2500, 0.08);
    bell(k, t + 0.1, 79, 0.16);
    bell(k, t + 0.24, 84, 0.16);
  },
  /** Coup joué, réponse enregistrée (neutre : ne dit rien de la réponse). */
  done: (k, t) => {
    marimba(k, t, 72, 0.18);
    marimba(k, t + 0.09, 67, 0.16);
  },
  /** Ouverture neutre (coffre, carte retournée en privé…). */
  open: (k, t) => {
    creak(k, t, 0.32, 0.09);
    whoosh(k, t + 0.2, 0.45, 600, 4500, 0.09);
    sparkle(k, t + 0.35, [84, 88, 91], 0.06, 0.05);
  },
  /** Choix verrouillé, décision prise. */
  lock: (k, t) => {
    hat(k, t, 0.12, 0.02);
    blip(k, t + 0.02, 160, 70, 0.12, 0.3);
    bell(k, t + 0.04, 96, 0.06, 0.6);
    bass(k, t + 0.04, 36, 0.25, 0.4);
  },
  /** Désignation au hasard (roulette qui s'arrête). */
  designate: (k, t) => {
    crash(k, t, 0.22);
    timpani(k, t, 36, 0.4);
    fanfare(k, t, [
      [0, 60, 0.1],
      [0.1, 64, 0.1],
      [0.2, 67, 0.1],
      [0.3, 72, 0.8],
    ]);
    sparkle(k, t + 0.35, [84, 88, 91, 96]);
  },
  /** Tic de roulette ou de sélection (varier `pitch`). */
  rouletteTick: (k, t, o) => woodblock(k, t, 0.13, 900 * (o.pitch ?? 1)),
  /** Alerte (évènement spécial, urgence). */
  alarm: (k, t) => {
    siren(k, t, 1.15);
    kick(k, t, 0.4);
    snare(k, t + 1.1, 0.2, 0.12);
  },

  // --- Temps ------------------------------------------------------------------------
  /** Tic d'horloge (dernières secondes). */
  tick: (k, t) => woodblock(k, t, 0.14, 1250),
  /** Temps écoulé. */
  timeout: (k, t) => buzzer(k, t, 0.75),

  // --- Révélation ------------------------------------------------------------------
  /** Roulement de tambour avant une révélation. */
  drumroll: (k, t, o) => drumroll(k, t, o.duration ?? 1.3),
  /** Raté (« wah wah wah waaah »). */
  fail: (k, t) => {
    snare(k, t, 0.2, 0.1);
    trombone(k, t + 0.05, 55, 0.3);
    trombone(k, t + 0.4, 54, 0.3);
    trombone(k, t + 0.75, 53, 0.3);
    trombone(k, t + 1.1, 52, 1.1, 0.22, true);
  },
  /** Bof. */
  meh: (k, t) => {
    snare(k, t, 0.18, 0.08);
    marimba(k, t + 0.02, 67, 0.3);
    marimba(k, t + 0.22, 64, 0.26);
    blip(k, t + 0.22, 200, 120, 0.12, 0.15);
  },
  /** Réussite. */
  success: (k, t) => {
    crash(k, t, 0.14, 1);
    kick(k, t, 0.45);
    [72, 76, 79, 84].forEach((m, i) => marimba(k, t + i * 0.07, m, 0.28));
    sparkle(k, t + 0.3, [88, 91]);
  },
  /** Grande réussite (fanfare). */
  fanfare: (k, t) => {
    crash(k, t, 0.22);
    timpani(k, t, 36, 0.45);
    fanfare(k, t, [
      [0, 67, 0.1],
      [0.12, 67, 0.1],
      [0.24, 72, 0.9],
    ]);
    fanfare(
      k,
      t + 0.24,
      [
        [0, 64, 0.9],
        [0, 60, 0.9],
      ],
      0.1,
    );
    sparkle(k, t + 0.3, [84, 88, 91, 96]);
  },
  /** Jackpot (fanfare, chœur et paillettes). */
  jackpot: (k, t) => {
    crash(k, t, 0.28, 2.2);
    timpani(k, t, 36, 0.55);
    timpani(k, t + 0.12, 43, 0.4);
    fanfare(k, t, [
      [0, 60, 0.1],
      [0.11, 64, 0.1],
      [0.22, 67, 0.1],
      [0.33, 72, 1.5],
    ]);
    fanfare(
      k,
      t + 0.33,
      [
        [0, 67, 1.5],
        [0, 64, 1.5],
      ],
      0.1,
    );
    choir(k, t + 0.3, [60, 64, 67, 72], 2, 0.05);
    sparkle(k, t + 0.4, [96, 91, 88, 84, 91, 96, 100], 0.08, 0.06);
  },
  /** Applaudissements. */
  applause: (k, t, o) => applause(k, t, o.duration ?? 2.6),
  /** Victoire (fin de partie). */
  victory: (k, t) => {
    crash(k, t, 0.22, 2);
    kick(k, t, 0.5);
    fanfare(k, t, [
      [0, 60, 0.14],
      [0.15, 65, 0.14],
      [0.3, 69, 0.14],
      [0.45, 72, 0.3],
      [0.8, 69, 0.14],
      [0.95, 72, 1.2],
    ]);
    sparkle(k, t + 1, [84, 88, 91, 96, 100]);
    applause(k, t + 0.3, 3, 0.26);
  },
  /** Nappe douce (confiance, moment calme). */
  calm: (k, t) => {
    pad(k, t, [60, 64, 67], 1.2, 0.03, 1200);
    bell(k, t, 76, 0.22, 2);
    bell(k, t + 0.32, 72, 0.22, 2);
  },
} satisfies Record<string, SfxRecipe>;

export type SfxName = keyof typeof SFX;
