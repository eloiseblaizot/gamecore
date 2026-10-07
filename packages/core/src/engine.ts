/**
 * Moteur pur : applique les fonctions d'un jeu en isolant leurs effets.
 *
 * Le serveur (ou le mode démo) appelle ces fonctions ; elles ne font aucune entrée/sortie.
 * Chaque appel reçoit l'état du générateur aléatoire et renvoie le nouveau, ainsi que la
 * liste des effets demandés par le jeu (événements à diffuser, minuteurs à programmer).
 */

import { GameError, INTERNAL_ERROR_MESSAGE, type ErrorCode } from "./errors.js";
import type { ActionContext, AnyGame, Audience, BaseContext, ViewContext } from "./game.js";
import { createRng, type RngState } from "./rng.js";
import type { Actor, GameSnapshot, PlayerInfo, Viewer } from "./types.js";

/** Événement éphémère demandé par le jeu. */
export interface GameEvent {
  name: string;
  data?: unknown;
  to: Audience;
}

/** Minuteur demandé par le jeu : programmer (`at` = horodatage absolu) ou annuler. */
export type TimerEffect =
  { op: "set"; key: string; at: number; action: unknown } | { op: "clear"; key: string };

export interface Effects {
  events: GameEvent[];
  timers: TimerEffect[];
}

/** Ce que le moteur doit savoir pour appeler le jeu. */
export interface EngineInput<Settings = unknown> {
  players: readonly PlayerInfo[];
  settings: Settings;
  now: number;
  rng: RngState;
}

export type EngineResult<State> =
  | { ok: true; state: State; rng: RngState; effects: Effects }
  /** `cause` : l'exception d'origine pour une erreur interne (à journaliser, jamais à renvoyer). */
  | { ok: false; error: GameError; cause?: unknown };

/** Refus levé par `ctx.reject()` : interrompt `reduce` et annule la copie de travail. */
class Rejection extends Error {
  override readonly name = "Rejection";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function baseContext<Settings>(input: EngineInput<Settings>, effects: Effects) {
  const random = createRng(input.rng);
  const ctx: BaseContext<Settings, unknown> = {
    now: input.now,
    random,
    settings: input.settings,
    players: input.players,
    schedule(key, delayMs, action) {
      if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError(`Délai invalide : ${delayMs}`);
      effects.timers.push({ op: "set", key, at: input.now + delayMs, action });
    },
    cancel(key) {
      effects.timers.push({ op: "clear", key });
    },
    emit(name, data, to = "all") {
      effects.events.push({ name, data, to });
    },
  };
  return { ctx, random };
}

function actionContext<Settings>(
  actor: Actor,
  input: EngineInput<Settings>,
  effects: Effects,
): { ctx: ActionContext<Settings, unknown>; random: ReturnType<typeof createRng> } {
  const { ctx: base, random } = baseContext(input, effects);
  const reject = (message: string): never => {
    throw new Rejection("RULE", message);
  };
  const ctx: ActionContext<Settings, unknown> = {
    ...base,
    actor,
    reject,
    requirePlayer() {
      if (actor.kind !== "player") throw new Rejection("FORBIDDEN", "Réservé aux joueurs de la partie.");
      return actor.id;
    },
    requireHost() {
      if (actor.kind === "system") return;
      if (!actor.isHost) throw new Rejection("FORBIDDEN", "Réservé à l'host de la partie.");
    },
  };
  return { ctx, random };
}

function failure(err: unknown): { ok: false; error: GameError; cause?: unknown } {
  if (err instanceof Rejection) return { ok: false, error: new GameError(err.code, err.message) };
  if (err instanceof GameError) return { ok: false, error: err };
  return { ok: false, error: new GameError("INTERNAL", INTERNAL_ERROR_MESSAGE), cause: err };
}

const emptyEffects = (): Effects => ({ events: [], timers: [] });

/** Crée l'état initial d'une partie. */
export function setupGame<State>(game: AnyGame, input: EngineInput): EngineResult<State> {
  const effects = emptyEffects();
  try {
    const { ctx, random } = baseContext(input, effects);
    const state = game.setup(ctx) as State;
    return { ok: true, state, rng: random.state(), effects };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Applique une action (déjà validée par le schéma) au nom de `actor`.
 * L'état d'entrée n'est jamais modifié : le jeu travaille sur une copie profonde.
 */
export function applyAction<State>(
  game: AnyGame,
  state: State,
  action: unknown,
  actor: Actor,
  input: EngineInput,
): EngineResult<State> {
  const effects = emptyEffects();
  try {
    const draft = structuredClone(state);
    const { ctx, random } = actionContext(actor, input, effects);
    const returned = game.reduce(draft, action, ctx) as State | undefined;
    return { ok: true, state: returned === undefined ? draft : returned, rng: random.state(), effects };
  } catch (err) {
    return failure(err);
  }
}

/** Retire définitivement un joueur de la partie (si le jeu le gère). */
export function applyPlayerLeave<State>(
  game: AnyGame,
  state: State,
  playerId: string,
  input: EngineInput,
): EngineResult<State> {
  const effects = emptyEffects();
  if (!game.onPlayerLeave) return { ok: true, state, rng: input.rng, effects };
  try {
    const draft = structuredClone(state);
    const { ctx, random } = actionContext({ kind: "system" }, input, effects);
    const returned = game.onPlayerLeave(draft, playerId, ctx) as State | undefined;
    return { ok: true, state: returned === undefined ? draft : returned, rng: random.state(), effects };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Valide une action envoyée par un client avec le schéma du jeu.
 * Les actions système ne sont jamais acceptées par ce chemin.
 */
export function parseClientAction(
  game: AnyGame,
  raw: unknown,
): { ok: true; action: unknown } | { ok: false; error: GameError } {
  const parsed = game.actions.safeParse(raw);
  if (!parsed.success) return { ok: false, error: new GameError("BAD_REQUEST", "Action invalide.") };
  return { ok: true, action: parsed.data };
}

/** Ce qu'un spectateur, un écran ou un joueur a le droit de voir de la partie. */
export function snapshotFor<Pub, Priv>(
  game: AnyGame,
  state: unknown,
  viewer: Viewer,
  ctx: ViewContext<unknown>,
  publicView?: Pub,
): GameSnapshot<Pub, Priv> {
  const pub = publicView ?? (game.views.public(state, ctx) as Pub);
  if (viewer.kind === "player" && game.views.private && ctx.players.some((p) => p.id === viewer.id)) {
    return { public: pub, private: game.views.private(state, viewer.id, ctx) as Priv };
  }
  return { public: pub };
}

/**
 * Fusionne une modification de réglages avec les réglages actuels et valide le résultat.
 * Renvoie une erreur lisible si le résultat ne respecte pas le schéma du jeu.
 */
export function resolveSettings<Settings>(
  game: AnyGame,
  current: Settings,
  patch: unknown,
): { ok: true; settings: Settings } | { ok: false; error: GameError } {
  const base = (current ?? game.settings.defaults) as Record<string, unknown>;
  const merged = typeof patch === "object" && patch !== null ? { ...base, ...patch } : base;
  const parsed = game.settings.schema.safeParse(merged);
  if (!parsed.success) return { ok: false, error: new GameError("BAD_REQUEST", "Réglages invalides.") };
  return { ok: true, settings: parsed.data as Settings };
}
