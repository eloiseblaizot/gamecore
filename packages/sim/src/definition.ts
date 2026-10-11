/**
 * Définition d'une simulation continue (`defineSimulation`).
 *
 * Contrairement à `defineGame` (jeux à tours, petit état copié à chaque action), une
 * simulation possède un état MUTABLE, souvent volumineux (grilles, graphes, TypedArray),
 * qui avance seul à tick fixe. L'hôte n'agit qu'à travers des commandes validées puis
 * journalisées ; l'interface ne reçoit que des canaux de snapshot, quand ils changent.
 *
 * Règles du déterminisme (vérifiées par `expectDeterministic`) : tout le hasard passe par
 * `ctx.random`, aucune horloge, aucune itération dans un ordre non garanti. Voir
 * docs/simulation.md.
 */

import type { Rng } from "@gamecore/core";
import type { z } from "zod";

/** Provenance d'une commande : l'hôte (UI, réseau, tests) ou la simulation elle-même. */
export type CommandOrigin = "host" | "system";

/** Derniers temps d'exécution (ms), en lecture seule. */
export interface SimProfileView {
  readonly tickMs: { readonly last: number; readonly avg: number };
  readonly systems: Readonly<
    Record<string, { readonly last: number; readonly avg: number; readonly runs: number }>
  >;
}

/** Contexte de `validate` : PUR (ni hasard, ni effets). */
export interface ValidateContext<Settings> {
  /** Tick pendant lequel la commande serait appliquée. */
  readonly tick: number;
  readonly settings: Settings;
  readonly origin: CommandOrigin;
}

/** Contexte de `create` et des systèmes. */
export interface SimContext<Settings, SystemCommand> {
  /** Numéro du tick en cours d'exécution (1 pour le premier) ; 0 dans `create`. */
  readonly tick: number;
  /** Hasard déterministe (SFC32 de @gamecore/core), sauvegardé avec la simulation. */
  readonly random: Rng;
  readonly settings: Settings;
  /** Événement éphémère vers l'hôte (son, notification…), livré au prochain `drain`. */
  emit(name: string, data?: unknown): void;
  /**
   * Programme une commande système dans `delayTicks` ticks (entier ≥ 1). Une seule par clé :
   * reprogrammer une clé remplace l'ancienne.
   */
  schedule(key: string, delayTicks: number, command: SystemCommand): void;
  /** Annule une commande programmée (sans effet si la clé n'existe pas). */
  cancel(key: string): void;
  /** Marque un canal à republier au prochain `drain`. */
  invalidate(channel: string): void;
  /** Derniers temps mesurés (lecture seule), `null` si le profilage est désactivé. */
  readonly profile: SimProfileView | null;
}

/** Contexte de `apply` : celui des systèmes, plus la provenance de la commande. */
export interface CommandContext<Settings, SystemCommand> extends SimContext<Settings, SystemCommand> {
  readonly origin: CommandOrigin;
}

/** Contexte des snapshots (lecture seule). */
export interface SnapshotContext<Settings> {
  /** Ticks terminés. */
  readonly tick: number;
  readonly settings: Settings;
}

export interface SimSystem<State, Settings, SystemCommand> {
  /** Nom unique (profilage, rapports d'erreur). */
  readonly name: string;
  /** Exécuté tous les `every` ticks (1 par défaut : à chaque tick). */
  readonly every?: number;
  update(state: State, ctx: SimContext<Settings, SystemCommand>): void;
}

export interface ChannelDefinition<State, Settings> {
  /** Republié automatiquement tous les `every` ticks (sinon : seulement quand il est invalidé). */
  readonly every?: number;
  /**
   * Donnée du canal. Elle peut être une vue directe de l'état (aucune copie) : l'hôte en
   * mémoire la reçoit telle quelle et ne doit pas la modifier.
   */
  build(state: State, ctx: SnapshotContext<Settings>): unknown;
  /**
   * La donnée est un TypedArray (ou un ArrayBuffer) à transférer vers la page sans copie
   * supplémentaire : le Worker en fait UNE copie, puis la transfère.
   */
  readonly transfer?: boolean;
}

export interface SimCodec<State> {
  /** État → octets (sans le journal, le RNG ni les réglages : le moteur s'en charge). */
  encode(state: State): Uint8Array;
  /** Octets (déjà migrés vers `version`) → état. */
  decode(bytes: Uint8Array, version: number): State;
}

export interface SimulationDefinition<
  State,
  Command,
  SystemCommand,
  Settings,
  Full,
  ChannelKey extends string,
> {
  /** Identifiant (minuscules, chiffres, tirets), comme `defineGame`. */
  readonly id: string;
  /** Version du format d'état, pour les migrations de sauvegarde (entier ≥ 1). */
  readonly version: number;
  /** Cadence nominale à vitesse ×1 (10 par défaut), utilisée par les hôtes cadencés. */
  readonly ticksPerSecond?: number;
  readonly settings: { readonly schema: z.ZodType<Settings>; readonly defaults: Settings };
  /** Commandes que l'HÔTE peut envoyer (discriminées par `type`). */
  readonly commands: z.ZodType<Command>;
  /** Commandes SYSTÈME (`ctx.schedule`), jamais acceptées de l'hôte. */
  readonly systemCommands?: z.ZodType<SystemCommand>;

  /** État initial (peut allouer des TypedArray). Déclarer `create` en premier aide l'inférence. */
  create(ctx: SimContext<Settings, SystemCommand>): State;
  /**
   * Validation PURE avant application : message de refus, ou `null`. C'est ici qu'on refuse
   * (« case hors de la carte ») : `apply` ne doit jamais échouer après avoir muté.
   */
  validate?(state: State, command: Command | SystemCommand, ctx: ValidateContext<Settings>): string | null;
  /** Application d'une commande acceptée : mute l'état. Ne lève jamais après la première mutation. */
  apply(state: State, command: Command | SystemCommand, ctx: CommandContext<Settings, SystemCommand>): void;
  /** Sous-systèmes, exécutés dans cet ordre à chaque tick (ou tous les `every` ticks). */
  readonly systems: readonly SimSystem<State, Settings, SystemCommand>[];
  /** Ce que l'hôte reçoit : un snapshot complet, et des canaux publiés quand ils changent. */
  readonly snapshot: {
    full(state: State, ctx: SnapshotContext<Settings>): Full;
    /** Canaux par nom (les clés sont inférées : `ChannelName<typeof maSimulation>`). */
    readonly channels?: { readonly [K in ChannelKey]: ChannelDefinition<State, Settings> };
  };
  readonly codec: SimCodec<State>;
  /** Migrations d'un format antérieur : `{ 1: octetsV1 => octetsV2, … }`, appliquées en chaîne. */
  readonly migrate?: Readonly<Record<number, (bytes: Uint8Array) => Uint8Array>>;
  /** Hash d'état pour les tests de déterminisme (par défaut : `hashState` sur l'état). */
  hash?(state: State): string;
}

/** Simulation dont on ne connaît pas les types précis. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySimulation = SimulationDefinition<any, any, any, any, any, any>;

/** Types d'une simulation : `SimTypes<typeof maSimulation>["command"]`. */
export type SimTypes<D> =
  D extends SimulationDefinition<infer S, infer C, infer SC, infer St, infer F, infer Ch>
    ? { state: S; command: C; systemCommand: SC; settings: St; full: F; channel: Ch }
    : never;

/** Nom des canaux d'une simulation. */
export type ChannelName<D> = SimTypes<D>["channel"];

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const NAME = /^[a-zA-Z][\w-]{0,63}$/;

const positiveInt = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1;

/**
 * Déclare une simulation : vérifie la cohérence de la définition et la renvoie telle quelle,
 * typée. Lève une erreur explicite au chargement plutôt qu'au premier tick.
 */
export function defineSimulation<
  State,
  Command,
  SystemCommand,
  Settings,
  Full,
  ChannelKey extends string = never,
>(
  definition: SimulationDefinition<State, Command, SystemCommand, Settings, Full, ChannelKey>,
): SimulationDefinition<State, Command, SystemCommand, Settings, Full, ChannelKey> {
  const where = `simulation « ${definition.id} »`;
  if (!ID.test(definition.id))
    throw new Error(`Identifiant invalide pour la ${where} (minuscules, chiffres, tirets).`);
  if (!positiveInt(definition.version)) throw new Error(`Version invalide pour la ${where} (entier ≥ 1).`);
  const tps = definition.ticksPerSecond ?? 10;
  if (!(tps > 0 && tps <= 240))
    throw new Error(`Cadence invalide pour la ${where} (entre 0 et 240 ticks par seconde).`);
  if (!definition.settings.schema.safeParse(definition.settings.defaults).success) {
    throw new Error(`Les réglages par défaut de la ${where} ne respectent pas leur schéma.`);
  }
  const names = new Set<string>();
  for (const system of definition.systems) {
    if (!NAME.test(system.name)) throw new Error(`Nom de système invalide « ${system.name} » (${where}).`);
    if (names.has(system.name)) throw new Error(`Deux systèmes s'appellent « ${system.name} » (${where}).`);
    if (system.every !== undefined && !positiveInt(system.every)) {
      throw new Error(`« every » du système « ${system.name} » : entier ≥ 1 attendu (${where}).`);
    }
    names.add(system.name);
  }
  const channels: Record<string, ChannelDefinition<State, Settings>> = definition.snapshot.channels ?? {};
  for (const [name, channel] of Object.entries(channels)) {
    if (!NAME.test(name)) throw new Error(`Nom de canal invalide « ${name} » (${where}).`);
    if (channel.every !== undefined && !positiveInt(channel.every)) {
      throw new Error(`« every » du canal « ${name} » : entier ≥ 1 attendu (${where}).`);
    }
  }
  for (const from of Object.keys(definition.migrate ?? {})) {
    const v = Number(from);
    if (!positiveInt(v) || v >= definition.version) {
      throw new Error(
        `Migration depuis la version ${from} invalide : elle doit être < ${definition.version} (${where}).`,
      );
    }
  }
  return definition;
}
