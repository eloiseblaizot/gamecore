/**
 * « Buzzer ! » — les règles du quiz, en fonctions pures.
 *
 * Déroulé : l'écran de l'hôte affiche une question et quatre réponses ; chaque joueur
 * répond sur son téléphone avant la fin du chrono. Plus on répond vite, plus on marque.
 * Quand tout le monde a répondu (ou à la fin du chrono), on révèle la bonne réponse,
 * puis l'host passe à la question suivante. Après la dernière : le podium.
 *
 * Ce qui est secret, et comment c'est protégé :
 *   - la bonne réponse : absente de la vue publique tant que la question est ouverte ;
 *   - la réponse de chaque joueur : seul le joueur la voit (vue privée) ; les autres
 *     savent seulement QUI a répondu, pas QUOI.
 *
 * Les règles sont une fabrique (`createBuzzer(questions)`) : le serveur les instancie avec
 * la banque de questions en ligne (`online.ts`), le mode démo avec sa propre banque. Ainsi
 * le JavaScript de la démo, téléchargeable par tous, ne contient jamais les réponses du
 * mode en ligne.
 */

import { defineGame } from "@gamecore/core";
import { z } from "zod";
import type { Question } from "./questions.js";

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 12;
/** Points pour une bonne réponse : la moitié d'office, l'autre moitié selon la rapidité. */
export const BASE_POINTS = 500;
export const SPEED_POINTS = 500;
/** Délai d'enchaînement automatique quand tout le monde a répondu. */
export const REVEAL_DELAY_MS = 800;

export type Choice = 0 | 1 | 2 | 3;

export interface Answer {
  choice: Choice;
  /** Horodatage serveur de la réponse. */
  at: number;
}

export interface BuzzerState {
  phase: "question" | "reveal" | "podium";
  /** Questions de la partie (tirées au hasard au lancement). */
  questions: Question[];
  index: number;
  /** Début et fin du chrono de la question en cours (horodatages serveur). */
  startedAt: number;
  deadline: number;
  /** Réponses de la question en cours, par joueur. */
  answers: Record<string, Answer>;
  /** Points gagnés à la question précédente (affichés pendant la révélation). */
  gained: Record<string, number>;
  scores: Record<string, number>;
  players: { id: string; name: string; avatar: string | null }[];
}

/** Réglages, bornés par la taille de la banque de questions. */
export function settingsSchemaFor(questionCount: number) {
  return z.strictObject({
    /** Nombre de questions de la partie. */
    questions: z.number().int().min(1).max(questionCount),
    /** Secondes pour répondre. */
    seconds: z.number().int().min(5).max(60),
    /** Webcams des joueurs (si le serveur a LiveKit). */
    camera: z.boolean(),
    /** Micros des joueurs (si le serveur a LiveKit). */
    micro: z.boolean(),
  });
}
export type BuzzerSettings = z.infer<ReturnType<typeof settingsSchemaFor>>;

/** Probabilité qu'un bot « connaisse » la bonne réponse (sinon il répond au hasard). */
export const BOT_SKILL = 0.6;

export const actionSchema = z.discriminatedUnion("type", [
  /** Un joueur répond. */
  z.strictObject({
    type: z.literal("answer"),
    choice: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  }),
  /** L'host passe à la suite (question suivante ou podium). */
  z.strictObject({ type: z.literal("next") }),
]);

export const systemActionSchema = z.discriminatedUnion("type", [
  /** Fin du chrono. */
  z.strictObject({ type: z.literal("timeout"), index: z.number().int() }),
  /** Tout le monde a répondu : révélation après un court suspense. */
  z.strictObject({ type: z.literal("reveal"), index: z.number().int() }),
]);

/** Ce que tout le monde voit (l'écran de l'hôte en particulier). */
export interface BuzzerPublic {
  phase: BuzzerState["phase"];
  index: number;
  total: number;
  question: { text: string; choices: readonly string[] };
  deadline: number;
  /** Durée totale du chrono (ms), pour dessiner la jauge. */
  duration: number;
  /** Qui a déjà répondu (mais pas quoi). */
  answered: string[];
  /** Présent uniquement pendant la révélation et sur le podium. */
  reveal: {
    correct: Choice;
    counts: [number, number, number, number];
    gained: Record<string, number>;
  } | null;
  scores: Record<string, number>;
  /** Classement, du premier au dernier (égalités au même rang). */
  ranking: { id: string; name: string; avatar: string | null; score: number; rank: number }[];
}

/** Ce que seul le joueur voit sur son téléphone. */
export interface BuzzerPrivate {
  myAnswer: Choice | null;
  /** Pendant la révélation : ai-je eu bon, combien ai-je gagné. */
  result: { correct: boolean; gained: number } | null;
}

function current(s: BuzzerState): Question {
  const question = s.questions[s.index];
  if (!question) throw new Error(`Question ${s.index} introuvable.`);
  return question;
}

/** Points d'une bonne réponse donnée à l'instant `at`. */
export function pointsFor(s: BuzzerState, at: number): number {
  const duration = s.deadline - s.startedAt;
  const remaining = Math.min(1, Math.max(0, (s.deadline - at) / duration));
  return Math.round(BASE_POINTS + SPEED_POINTS * remaining);
}

function reveal(s: BuzzerState): void {
  const { answer } = current(s);
  s.gained = {};
  for (const [id, a] of Object.entries(s.answers)) {
    const gained = a.choice === answer ? pointsFor(s, a.at) : 0;
    s.gained[id] = gained;
    s.scores[id] = (s.scores[id] ?? 0) + gained;
  }
  s.phase = "reveal";
}

function ranking(s: BuzzerState): BuzzerPublic["ranking"] {
  const sorted = s.players
    .map((p) => ({ ...p, score: s.scores[p.id] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "fr"));
  return sorted.map((p) => ({ ...p, rank: sorted.findIndex((q) => q.score === p.score) + 1 }));
}

export const createBuzzer = (bank: readonly Question[]) =>
  defineGame({
    id: "buzzer",
    name: "Buzzer !",
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    settings: {
      schema: settingsSchemaFor(bank.length),
      defaults: { questions: Math.min(5, bank.length), seconds: 15, camera: false, micro: false },
    },
    actions: actionSchema,
    systemActions: systemActionSchema,

    setup(ctx): BuzzerState {
      const duration = ctx.settings.seconds * 1000;
      ctx.schedule("timer", duration, { type: "timeout", index: 0 });
      return {
        phase: "question",
        questions: ctx.random.shuffle(bank).slice(0, ctx.settings.questions),
        index: 0,
        startedAt: ctx.now,
        deadline: ctx.now + duration,
        answers: {},
        gained: {},
        scores: Object.fromEntries(ctx.players.map((p) => [p.id, 0])),
        players: ctx.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar })),
      };
    },

    reduce(s, action, ctx) {
      switch (action.type) {
        case "answer": {
          const me = ctx.requirePlayer();
          if (s.phase !== "question") ctx.reject("Les réponses sont fermées.");
          if (ctx.now > s.deadline) ctx.reject("Trop tard !");
          if (s.answers[me]) ctx.reject("Tu as déjà répondu.");
          s.answers[me] = { choice: action.choice, at: ctx.now };
          ctx.emit("answered", { by: me }, "screens");
          if (s.players.every((p) => s.answers[p.id])) {
            ctx.cancel("timer");
            ctx.schedule("timer", REVEAL_DELAY_MS, { type: "reveal", index: s.index });
          }
          return;
        }

        case "next": {
          ctx.requireHost();
          if (s.phase !== "reveal") ctx.reject("Attends la fin de la question.");
          if (s.index + 1 >= s.questions.length) {
            s.phase = "podium";
            return;
          }
          const duration = ctx.settings.seconds * 1000;
          s.index++;
          s.phase = "question";
          s.answers = {};
          s.gained = {};
          s.startedAt = ctx.now;
          s.deadline = ctx.now + duration;
          ctx.schedule("timer", duration, { type: "timeout", index: s.index });
          return;
        }

        case "timeout":
        case "reveal":
          // Garde-fou : une action système d'une question précédente est ignorée.
          if (ctx.actor.kind !== "system" || s.phase !== "question" || action.index !== s.index) return;
          reveal(s);
          ctx.emit("reveal", { index: s.index }, "all");
          return;
      }
    },

    views: {
      public(s): BuzzerPublic {
        const q = current(s);
        const open = s.phase === "question";
        const counts: [number, number, number, number] = [0, 0, 0, 0];
        if (!open) for (const a of Object.values(s.answers)) counts[a.choice]++;
        return {
          phase: s.phase,
          index: s.index,
          total: s.questions.length,
          question: { text: q.text, choices: q.choices },
          deadline: s.deadline,
          duration: s.deadline - s.startedAt,
          answered: Object.keys(s.answers),
          reveal: open ? null : { correct: q.answer, counts, gained: s.gained },
          scores: s.scores,
          ranking: ranking(s),
        };
      },
      private(s, playerId): BuzzerPrivate {
        const mine = s.answers[playerId];
        return {
          myAnswer: mine?.choice ?? null,
          result:
            s.phase === "question"
              ? null
              : { correct: mine?.choice === current(s).answer, gained: s.gained[playerId] ?? 0 },
        };
      },
    },

    isOver: (s) => s.phase === "podium",

    onPlayerLeave(s, playerId, ctx) {
      s.players = s.players.filter((p) => p.id !== playerId);
      delete s.answers[playerId];
      delete s.scores[playerId];
      if (s.phase === "question" && s.players.length > 0 && s.players.every((p) => s.answers[p.id])) {
        ctx.cancel("timer");
        ctx.schedule("timer", REVEAL_DELAY_MS, { type: "reveal", index: s.index });
      }
    },

    // Bots : ils répondent à chaque question après un temps de réflexion, et « connaissent » la
    // bonne réponse avec une probabilité BOT_SKILL (lue dans l'état complet), sinon ils devinent.
    bots: {
      names: [
        "Quizbot",
        "Mme Je-sais-tout",
        "Professeur Hasard",
        "Petit Génie",
        "Tonton Culture",
        "La Chouette",
      ],
      decide(view, state, ctx) {
        if (view.public.phase !== "question" || view.private?.myAnswer !== null) return null;
        const correct = current(state).answer;
        const choice = ctx.random.chance(BOT_SKILL) ? correct : (ctx.random.int(0, 3) as Choice);
        return { type: "answer" as const, choice };
      },
      // Entre 1,5 s et 70 % du chrono : les bots laissent aux humains le temps de répondre.
      delay: (_action, ctx) => 1500 + ctx.random.next() * Math.max(0, ctx.settings.seconds * 700 - 1500),
    },
  });

export type Buzzer = ReturnType<typeof createBuzzer>;
