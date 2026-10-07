import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyAction,
  applyPlayerLeave,
  parseClientAction,
  resolveSettings,
  setupGame,
  snapshotFor,
} from "./engine.js";
import { defineGame } from "./game.js";
import { seedFromString } from "./rng.js";
import type { Actor, PlayerInfo } from "./types.js";

/**
 * Jeu de test : chaque joueur reçoit un nombre secret ; on gagne un point en devinant
 * celui d'un autre joueur. Il couvre secrets, vues privées, minuteurs et événements.
 */
interface State {
  secrets: Record<string, number>;
  scores: Record<string, number>;
  turn: number;
  log: string[];
}

const game = defineGame({
  id: "secret-number",
  name: "Nombre secret",
  minPlayers: 2,
  maxPlayers: 4,
  settings: {
    schema: z.strictObject({ max: z.number().int().min(2).max(100), turnSeconds: z.number().int().min(0) }),
    defaults: { max: 10, turnSeconds: 30 },
  },
  actions: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("guess"), target: z.string(), value: z.number().int() }),
    z.strictObject({ type: z.literal("reset") }),
    z.strictObject({ type: z.literal("crash") }),
  ]),
  systemActions: z.strictObject({ type: z.literal("timeout") }),
  setup(ctx): State {
    const secrets: Record<string, number> = {};
    for (const p of ctx.players) secrets[p.id] = ctx.random.int(1, ctx.settings.max);
    ctx.schedule("turn", ctx.settings.turnSeconds * 1000, { type: "timeout" });
    return { secrets, scores: Object.fromEntries(ctx.players.map((p) => [p.id, 0])), turn: 1, log: [] };
  },
  reduce(draft, action, ctx) {
    switch (action.type) {
      case "guess": {
        const me = ctx.requirePlayer();
        if (action.target === me) ctx.reject("Devine le nombre d'un autre joueur.");
        draft.log.push(`${me}→${action.target}`);
        if (draft.secrets[action.target] === action.value) {
          draft.scores[me] = (draft.scores[me] ?? 0) + 1;
          ctx.emit("found", { by: me }, "screens");
        }
        draft.turn++;
        ctx.schedule("turn", 1000, { type: "timeout" });
        return;
      }
      case "reset":
        ctx.requireHost();
        draft.log = [];
        ctx.cancel("turn");
        return;
      case "crash":
        draft.log.push("modification qui doit être annulée");
        throw new Error("bug du jeu");
      case "timeout":
        if (ctx.actor.kind !== "system") ctx.reject("Réservé au système.");
        draft.turn++;
        return;
    }
  },
  views: {
    public: (s) => ({ scores: s.scores, turn: s.turn }),
    private: (s, playerId) => ({ secret: s.secrets[playerId] }),
  },
  isOver: (s) => Object.values(s.scores).some((v) => v >= 3),
  onPlayerLeave(draft, playerId) {
    delete draft.secrets[playerId];
    delete draft.scores[playerId];
  },
});

const players: PlayerInfo[] = [
  { id: "a", name: "Alice", avatar: null, connected: true },
  { id: "b", name: "Bob", avatar: null, connected: true },
];
const input = (now = 1000) => ({
  players,
  settings: game.settings.defaults,
  now,
  rng: seedFromString("test"),
});
const alice: Actor = { kind: "player", id: "a", isHost: true };
const bob: Actor = { kind: "player", id: "b", isHost: false };

function started() {
  const res = setupGame<State>(game, input());
  if (!res.ok) throw res.error;
  return res;
}

describe("defineGame", () => {
  it("refuse une définition incohérente", () => {
    expect(() => defineGame({ ...game, id: "Mauvais Id" })).toThrow(/Identifiant/);
    expect(() => defineGame({ ...game, minPlayers: 5, maxPlayers: 2 })).toThrow(/joueurs/);
    expect(() =>
      defineGame({ ...game, settings: { ...game.settings, defaults: { max: 1, turnSeconds: 0 } } }),
    ).toThrow(/réglages/);
  });
});

describe("setupGame", () => {
  it("est déterministe pour une même graine et programme les minuteurs demandés", () => {
    const a = started();
    const b = started();
    expect(a.state).toEqual(b.state);
    expect(a.rng).toEqual(b.rng);
    expect(a.effects.timers).toEqual([{ op: "set", key: "turn", at: 31_000, action: { type: "timeout" } }]);
  });
});

describe("applyAction", () => {
  it("applique une action valide sans modifier l'état d'origine", () => {
    const { state, rng } = started();
    const before = structuredClone(state);
    const res = applyAction<State>(
      game,
      state,
      { type: "guess", target: "b", value: state.secrets.b },
      alice,
      {
        ...input(2000),
        rng,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.scores.a).toBe(1);
    expect(res.effects.events).toEqual([{ name: "found", data: { by: "a" }, to: "screens" }]);
    expect(res.effects.timers).toEqual([{ op: "set", key: "turn", at: 3000, action: { type: "timeout" } }]);
    expect(state).toEqual(before);
  });

  it("refuse avec le message du jeu et sans effet de bord", () => {
    const { state } = started();
    const res = applyAction<State>(game, state, { type: "guess", target: "a", value: 1 }, alice, input());
    expect(res).toMatchObject({
      ok: false,
      error: { code: "RULE", message: "Devine le nombre d'un autre joueur." },
    });
    expect(state.log).toEqual([]);
  });

  it("réserve les actions aux bons acteurs", () => {
    const { state } = started();
    const spectator: Actor = { kind: "spectator", id: "s", isHost: false };
    expect(
      applyAction(game, state, { type: "guess", target: "b", value: 1 }, spectator, input()),
    ).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(applyAction(game, state, { type: "reset" }, bob, input())).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const screen: Actor = { kind: "screen", isHost: true };
    const res = applyAction(game, state, { type: "reset" }, screen, input());
    expect(res).toMatchObject({ ok: true, effects: { timers: [{ op: "clear", key: "turn" }] } });
    expect(applyAction(game, state, { type: "reset" }, { kind: "system" }, input()).ok).toBe(true);
  });

  it("masque les erreurs inattendues du jeu et annule ses modifications", () => {
    const { state } = started();
    const res = applyAction<State>(game, state, { type: "crash" }, alice, input());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INTERNAL");
    expect(res.error.message).not.toContain("bug du jeu");
    expect(res.cause).toBeInstanceOf(Error);
    expect(state.log).toEqual([]);
  });
});

describe("parseClientAction", () => {
  it("n'accepte que les actions client du schéma, jamais les actions système", () => {
    expect(parseClientAction(game, { type: "reset" })).toEqual({ ok: true, action: { type: "reset" } });
    expect(parseClientAction(game, { type: "timeout" }).ok).toBe(false);
    expect(parseClientAction(game, { type: "reset", extra: true }).ok).toBe(false);
    expect(parseClientAction(game, "reset").ok).toBe(false);
  });
});

describe("snapshotFor", () => {
  it("ne donne la vue privée qu'au joueur concerné", () => {
    const { state } = started();
    const ctx = { now: 0, settings: game.settings.defaults, players };
    const forAlice = snapshotFor(game, state, alice, ctx);
    expect(forAlice.private).toEqual({ secret: state.secrets.a });
    const forScreen = snapshotFor(game, state, { kind: "screen", isHost: true }, ctx);
    expect(forScreen).toEqual({ public: { scores: { a: 0, b: 0 }, turn: 1 } });
    expect(JSON.stringify(forScreen)).not.toContain("secrets");
    const intruder = snapshotFor(game, state, { kind: "player", id: "zz", isHost: false }, ctx);
    expect(intruder.private).toBeUndefined();
  });
});

describe("applyPlayerLeave", () => {
  it("laisse le jeu retirer le joueur", () => {
    const { state } = started();
    const res = applyPlayerLeave<State>(game, state, "b", input());
    expect(res.ok && Object.keys(res.state.scores)).toEqual(["a"]);
  });
});

describe("resolveSettings", () => {
  it("fusionne et valide les réglages", () => {
    expect(resolveSettings(game, game.settings.defaults, { max: 50 })).toEqual({
      ok: true,
      settings: { max: 50, turnSeconds: 30 },
    });
    expect(resolveSettings(game, game.settings.defaults, { max: 1 }).ok).toBe(false);
    expect(resolveSettings(game, game.settings.defaults, { hack: true }).ok).toBe(false);
  });
});
