/**
 * @gamecore/sim/testing — outils de test des simulations : rejeu, vérification du
 * déterminisme, banc d'essai, hash d'état, fausses horloges pour le cadenceur.
 */

export { createFakeClock, type FakeClock } from "./fake-clock.js";
export { hashState } from "./hash.js";
export { replay, type ReplayInput } from "./replay.js";
export {
  DeterminismError,
  benchmark,
  expectDeterministic,
  type BenchmarkOptions,
  type BenchmarkReport,
  type DeterminismOptions,
  type DeterminismReport,
  type SimScript,
  type TimingStats,
} from "./tools.js";
