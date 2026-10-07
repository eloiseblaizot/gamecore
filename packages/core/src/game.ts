/**
 * Définition d'un jeu.
 *
 * Un jeu gamecore est un ensemble de fonctions PURES : aucune ne touche au réseau, à
 * l'horloge ou au hasard global. Tout ce dont elles ont besoin arrive par le contexte.
 * C'est ce qui permet de :
 *   - tester les règles sans serveur, avec une graine fixe ;
 *   - faire tourner la même partie sur un serveur Node (Socket.io), sur Cloudflare
 *     (PartyKit) ou directement dans le navigateur (mode démo contre des bots) ;
 *   - garantir qu'aucune information secrète ne fuit : un client ne reçoit JAMAIS l'état
 *     complet, seulement la projection calculée par `views`.
 *
 * Exemple minimal : voir `examples/buzzer/src/game.ts` et le guide `docs/creer-un-jeu.md`.
 */

import type { z } from "zod";
import type { Rng } from "./rng.js";
import type { Actor, PlayerInfo } from "./types.js";

/** Destinataires d'un événement éphémère. */
export type Audience =
  /** Tout le salon : joueurs, spectateurs et écrans. */
  | "all"
  /** Les écrans partagés uniquement (animations, sons de l'écran de l'hôte…). */
  | "screens"
  /** Tous les joueurs de la partie. */
  | "players"
  /** Ces membres-là uniquement (identifiants). */
  | { readonly only: readonly string[] };

/** Contexte commun à `setup`, `reduce` et `onPlayerLeave`. */
export interface BaseContext<Settings, SystemAction> {
  /** Horodatage (ms) de l'action, fourni par le serveur. */
  readonly now: number;
  /** Hasard déterministe du salon (voir `rng.ts`). */
  readonly random: Rng;
  readonly settings: Settings;
  /** Joueurs de la partie (pseudo, avatar, connecté ou non). */
  readonly players: readonly PlayerInfo[];
  /**
   * Programme une action système dans `delayMs` millisecondes (fin de chrono, enchaînement
   * automatique…). Une seule action par clé : reprogrammer une clé remplace l'ancienne.
   */
  schedule(key: string, delayMs: number, action: SystemAction): void;
  /** Annule une action programmée (sans effet si la clé n'existe pas). */
  cancel(key: string): void;
  /**
   * Envoie un événement éphémère (son, animation, notification). Il n'est pas stocké :
   * un client qui se reconnecte ne le reçoit pas. Ce qui doit durer va dans l'état.
   */
  emit(name: string, data?: unknown, to?: Audience): void;
}

/** Contexte de `setup`. */
export type SetupContext<Settings, SystemAction> = BaseContext<Settings, SystemAction>;

/** Contexte de `reduce` : qui agit, et des aides pour refuser une action proprement. */
export interface ActionContext<Settings, SystemAction> extends BaseContext<Settings, SystemAction> {
  readonly actor: Actor;
  /** Refuse l'action : l'état est laissé intact et le message est affiché au joueur. */
  reject(message: string): never;
  /** Renvoie l'identifiant du joueur qui agit, ou refuse si ce n'est pas un joueur. */
  requirePlayer(): string;
  /** Refuse si l'action ne vient ni de l'host (joueur, spectateur ou écran admin) ni du système. */
  requireHost(): void;
}

/** Contexte des vues. */
export interface ViewContext<Settings> {
  readonly now: number;
  readonly settings: Settings;
  readonly players: readonly PlayerInfo[];
}

export interface GameDefinition<
  State,
  Action,
  Settings,
  PublicView,
  PrivateView = never,
  SystemAction = never,
> {
  /** Identifiant technique (minuscules, chiffres et tirets), ex. « buzzer ». */
  readonly id: string;
  /** Nom affiché. */
  readonly name: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;

  /** Réglages modifiables par l'host dans le salon d'attente. */
  readonly settings: {
    /** Schéma zod : toute modification est validée avant d'être appliquée. */
    readonly schema: z.ZodType<Settings>;
    readonly defaults: Settings;
  };

  /**
   * Schéma des actions que les CLIENTS peuvent envoyer. Tout ce qui n'y est pas conforme
   * est rejeté par le serveur avant même d'atteindre `reduce`.
   */
  readonly actions: z.ZodType<Action>;

  /**
   * Schéma des actions SYSTÈME, programmées par le jeu lui-même via `ctx.schedule`
   * (fin de chrono…). Il sert à typer `reduce` et à revalider l'action au déclenchement ;
   * ces actions ne sont jamais acceptées depuis un client.
   */
  readonly systemActions?: z.ZodType<SystemAction>;

  /**
   * Création de l'état initial au lancement de la partie.
   * Astuce : déclarer `setup` AVANT `reduce` aide TypeScript à inférer le type de l'état.
   */
  setup(ctx: SetupContext<Settings, SystemAction>): State;

  /**
   * Applique une action. `draft` est une copie de l'état : on peut la modifier directement
   * (ou renvoyer un nouvel état). Si l'action est refusée (`ctx.reject`) ou si une exception
   * est levée, la copie est jetée : l'état du salon n'est jamais à moitié modifié.
   *
   * Les actions système (programmées via `ctx.schedule`) arrivent ici avec
   * `ctx.actor.kind === "system"` ; les clients ne peuvent pas en envoyer.
   */
  reduce(
    draft: State,
    action: Action | SystemAction,
    ctx: ActionContext<Settings, SystemAction>,
  ): State | void;

  /**
   * Projections de l'état, la seule chose que les clients reçoivent.
   *   - `public` : ce que tout le monde voit (l'écran géant, les spectateurs) ;
   *   - `private` : ce que CE joueur est seul à voir (sa main, sa réponse…).
   * ⚠️ Ne jamais mettre d'information secrète dans `public`.
   */
  readonly views: {
    public(state: State, ctx: ViewContext<Settings>): PublicView;
    private?(state: State, playerId: string, ctx: ViewContext<Settings>): PrivateView;
  };

  /** La partie est-elle terminée ? Le salon passe alors au statut « finished ». */
  isOver?(state: State): boolean;

  /**
   * Un joueur quitte définitivement la partie (départ volontaire ou expulsion).
   * Une simple déconnexion n'appelle PAS cette fonction : le joueur peut revenir.
   */
  onPlayerLeave?(draft: State, playerId: string, ctx: ActionContext<Settings, SystemAction>): State | void;
}

/** Jeu dont on ne connaît pas les types précis (côté serveur, modules…). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGame = GameDefinition<any, any, any, any, any, any>;

/** Extraction des types d'un jeu, pratique côté client : `GameTypes<typeof buzzer>["action"]`. */
export type GameTypes<G> =
  G extends GameDefinition<infer S, infer A, infer St, infer Pub, infer Priv, infer Sys>
    ? { state: S; action: A; settings: St; publicView: Pub; privateView: Priv; systemAction: Sys }
    : never;

const GAME_ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Déclare un jeu. Ne fait que vérifier la cohérence de la définition et la renvoyer telle
 * quelle, typée : c'est le point d'entrée recommandé pour bénéficier de l'inférence.
 */
export function defineGame<State, Action, Settings, PublicView, PrivateView = never, SystemAction = never>(
  definition: GameDefinition<State, Action, Settings, PublicView, PrivateView, SystemAction>,
): GameDefinition<State, Action, Settings, PublicView, PrivateView, SystemAction> {
  if (!GAME_ID.test(definition.id)) {
    throw new Error(`Identifiant de jeu invalide « ${definition.id} » (minuscules, chiffres, tirets).`);
  }
  const { minPlayers, maxPlayers } = definition;
  if (
    !Number.isInteger(minPlayers) ||
    !Number.isInteger(maxPlayers) ||
    minPlayers < 1 ||
    maxPlayers < minPlayers
  ) {
    throw new Error(`Nombre de joueurs invalide pour « ${definition.id} » : ${minPlayers}–${maxPlayers}.`);
  }
  const defaults = definition.settings.schema.safeParse(definition.settings.defaults);
  if (!defaults.success) {
    throw new Error(`Les réglages par défaut de « ${definition.id} » ne respectent pas leur schéma.`);
  }
  return definition;
}
