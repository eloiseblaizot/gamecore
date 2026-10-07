/**
 * Jeu de test : pierre-feuille-ciseaux à plusieurs. Chaque joueur choisit en secret ;
 * quand tout le monde a choisi (ou à la fin du chrono), on révèle et on compte les points.
 * Il exerce tout ce que le serveur doit garantir : secrets, vues privées, minuteurs,
 * événements ciblés, départ d'un joueur, fin de partie.
 */

import { defineGame } from "@gamecore/core";
import { z } from "zod";

export const CHOICES = ["rock", "paper", "scissors"] as const;
export type Choice = (typeof CHOICES)[number];

export interface RpsState {
  round: number;
  rounds: number;
  phase: "choosing" | "reveal" | "over";
  choices: Record<string, Choice | null>;
  scores: Record<string, number>;
  last: Record<string, Choice> | null;
}

const BEATS: Record<Choice, Choice> = { rock: "scissors", paper: "rock", scissors: "paper" };

function resolve(s: RpsState, emit: (name: string, data?: unknown) => void) {
  const picks = Object.entries(s.choices) as [string, Choice][];
  for (const [id, choice] of picks) {
    for (const [, other] of picks) if (BEATS[choice] === other) s.scores[id] = (s.scores[id] ?? 0) + 1;
  }
  s.last = Object.fromEntries(picks);
  s.phase = "reveal";
  emit("reveal", { round: s.round });
}

export const rps = defineGame({
  id: "rps",
  name: "Pierre-feuille-ciseaux",
  minPlayers: 2,
  maxPlayers: 4,
  settings: {
    schema: z.strictObject({
      rounds: z.number().int().min(1).max(10),
      turnMs: z.number().int().min(1000).max(60_000),
    }),
    defaults: { rounds: 2, turnMs: 10_000 },
  },
  actions: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("choose"), choice: z.enum(CHOICES) }),
    z.strictObject({ type: z.literal("next") }),
    z.strictObject({ type: z.literal("boom") }),
  ]),
  systemActions: z.strictObject({ type: z.literal("timeout") }),

  setup(ctx): RpsState {
    ctx.schedule("turn", ctx.settings.turnMs, { type: "timeout" });
    return {
      round: 1,
      rounds: ctx.settings.rounds,
      phase: "choosing",
      choices: Object.fromEntries(ctx.players.map((p) => [p.id, null])),
      scores: Object.fromEntries(ctx.players.map((p) => [p.id, 0])),
      last: null,
    };
  },

  reduce(s, action, ctx) {
    const emit = (name: string, data?: unknown) => ctx.emit(name, data, "screens");
    switch (action.type) {
      case "choose": {
        const me = ctx.requirePlayer();
        if (s.phase !== "choosing") ctx.reject("Ce n'est pas le moment de choisir.");
        if (s.choices[me] !== null) ctx.reject("Tu as déjà choisi.");
        s.choices[me] = action.choice;
        ctx.emit("chosen", { by: me }, "screens");
        if (Object.values(s.choices).every((c) => c !== null)) {
          ctx.cancel("turn");
          resolve(s, emit);
        }
        return;
      }
      case "next":
        ctx.requireHost();
        if (s.phase !== "reveal") ctx.reject("Termine d'abord la manche.");
        if (s.round >= s.rounds) {
          s.phase = "over";
          return;
        }
        s.round++;
        s.phase = "choosing";
        for (const id of Object.keys(s.choices)) s.choices[id] = null;
        ctx.schedule("turn", ctx.settings.turnMs, { type: "timeout" });
        return;
      case "boom":
        throw new Error("secret interne : la base de données est à 10.0.0.12");
      case "timeout":
        if (ctx.actor.kind !== "system") ctx.reject("Réservé au système.");
        if (s.phase !== "choosing") return;
        for (const id of Object.keys(s.choices)) s.choices[id] ??= ctx.random.pick(CHOICES);
        resolve(s, emit);
        return;
    }
  },

  views: {
    public: (s) => ({
      round: s.round,
      rounds: s.rounds,
      phase: s.phase,
      scores: s.scores,
      // Qui a choisi est public ; QUOI, seulement après la révélation.
      chosen: Object.keys(s.choices).filter((id) => s.choices[id] !== null),
      last: s.last,
    }),
    private: (s, playerId) => ({ myChoice: s.choices[playerId] ?? null }),
  },

  isOver: (s) => s.phase === "over",

  onPlayerLeave(s, playerId, ctx) {
    delete s.choices[playerId];
    delete s.scores[playerId];
    if (s.phase === "choosing" && Object.values(s.choices).every((c) => c !== null)) {
      ctx.cancel("turn");
      resolve(s, (name, data) => ctx.emit(name, data, "screens"));
    }
  },
});

export type RpsPublic = ReturnType<typeof rps.views.public>;
export type RpsPrivate = { myChoice: Choice | null };
