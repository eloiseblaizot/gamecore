/**
 * Rejeu du journal : recrée une simulation depuis sa graine (ou depuis une sauvegarde de base)
 * et réapplique les commandes au tick où elles avaient été appliquées. Grâce au déterminisme,
 * on retrouve exactement le même état — c'est ce qui permet de reproduire un bug signalé.
 */

import type { AnySimulation, SimTypes } from "./definition.js";
import { createSimulation, loadSimulation, type Sim, type SimOptions } from "./simulation.js";

export interface ReplayInput<D extends AnySimulation> {
  /** Graine d'origine (obligatoire sans `base`). */
  seed?: string | null;
  /** Réglages d'origine. */
  settings?: Partial<SimTypes<D>["settings"]>;
  /** Point de départ au lieu de la graine : une sauvegarde, par exemple `sim.journalBase`. */
  base?: Uint8Array | null;
  /** Commandes à réappliquer, triées par tick (le `seq` éventuel est ignoré). */
  journal: readonly { readonly tick: number; readonly command: unknown }[];
  /** Tick où s'arrêter (par défaut : celui de la dernière commande). */
  untilTick?: number;
  /** Options de la simulation recréée (profilage désactivé par défaut). */
  options?: Omit<SimOptions<SimTypes<D>["settings"]>, "seed" | "settings">;
}

/** Rejoue un journal ; renvoie la simulation obtenue, arrêtée au tick `untilTick`. */
export function replay<D extends AnySimulation>(definition: D, input: ReplayInput<D>): Sim<D> {
  const options = { profile: false, maxQueuedCommands: Number.MAX_SAFE_INTEGER, ...input.options };
  let sim: Sim<D>;
  if (input.base) {
    sim = loadSimulation(definition, input.base, options);
  } else {
    if (typeof input.seed !== "string")
      throw new Error("Rejeu impossible sans la graine d'origine (ni sauvegarde de base).");
    sim = createSimulation(definition, { ...options, seed: input.seed, settings: input.settings });
  }

  const journal = input.journal;
  let previous = sim.tick + 1;
  for (const entry of journal) {
    if (!Number.isInteger(entry.tick) || entry.tick < previous) {
      throw new RangeError(`Journal non trié, ou antérieur au point de départ (tick ${entry.tick}).`);
    }
    previous = entry.tick;
  }
  const until = input.untilTick ?? Math.max(sim.tick, journal.at(-1)?.tick ?? 0);
  if (!Number.isInteger(until) || until < sim.tick) {
    throw new RangeError(`untilTick invalide : ${until} (la simulation part du tick ${sim.tick}).`);
  }
  for (const entry of journal) {
    if (entry.tick > until) break;
    // Avance jusqu'au tick précédent, puis met la commande en file pour le tick `entry.tick`.
    sim.step(entry.tick - 1 - sim.tick);
    const result = sim.dispatch(entry.command);
    if (!result.ok)
      throw new Error(`Commande du journal refusée au tick ${entry.tick} : ${result.error.message}`);
  }
  sim.step(until - sim.tick);
  if (sim.corrupted)
    throw new Error(
      `Le rejeu a corrompu la simulation au tick ${sim.corrupted.tick} : ${sim.corrupted.cause}`,
    );
  return sim;
}
