/**
 * @gamecore/sim — moteur de simulation continue : tick fixe, état mutable appartenant au
 * moteur, commandes validées puis journalisées, canaux de snapshot, sauvegarde et rejeu
 * déterministes. Complète `defineGame` (jeux à tours, petit état) sans le remplacer.
 * Voir docs/simulation.md et l'ADR 0004.
 */

export { ByteReader, ByteWriter } from "./bytes.js";
export { fnv1a64, hashState } from "./hash.js";
