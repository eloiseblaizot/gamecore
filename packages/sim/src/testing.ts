/**
 * @gamecore/sim/testing — outils de test des simulations : hash d'état, fausses horloges
 * pour le cadenceur (et, au fil des étapes suivantes, rejeu, déterminisme, banc d'essai).
 */

export { createFakeClock, type FakeClock } from "./fake-clock.js";
export { hashState } from "./hash.js";
