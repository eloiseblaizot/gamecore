/**
 * @gamecore/sim — moteur de simulation continue : tick fixe, état mutable appartenant au
 * moteur, commandes validées puis journalisées, canaux de snapshot, sauvegarde et rejeu
 * déterministes. Complète `defineGame` (jeux à tours, petit état) sans le remplacer.
 * Voir docs/simulation.md et l'ADR 0004.
 */

export { ByteReader, ByteWriter } from "./bytes.js";
export {
  defineSimulation,
  type AnySimulation,
  type ChannelDefinition,
  type ChannelName,
  type CommandContext,
  type CommandOrigin,
  type SimCodec,
  type SimContext,
  type SimProfileView,
  type SimSystem,
  type SimTypes,
  type SimulationDefinition,
  type SnapshotContext,
  type ValidateContext,
} from "./definition.js";
export { fnv1a64, hashState } from "./hash.js";
export {
  createSimulation,
  type CommandRejection,
  type CorruptionInfo,
  type DispatchResult,
  type DrainPayload,
  type JournalEntry,
  type ScheduledCommand,
  type Sim,
  type SimEvent,
  type SimOptions,
  type SimProfile,
  type SimSnapshot,
} from "./simulation.js";
