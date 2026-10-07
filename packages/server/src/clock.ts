/**
 * Horloge injectable : le runtime ne lit jamais `Date.now()` ni `setTimeout` directement,
 * ce qui permet de tester les minuteurs (fin de chrono, délai de reconnexion…) en accéléré.
 */

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Délai max accepté par `setTimeout` (≈ 24,8 jours) : au-delà, le minuteur partirait aussitôt. */
const MAX_DELAY = 2 ** 31 - 1;

/**
 * Horloge système. Les fonctions globales sont lues à chaque appel (et non capturées au
 * chargement du module) pour rester compatibles avec les faux minuteurs des tests.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, Math.min(Math.max(0, ms), MAX_DELAY)),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};
