/**
 * Transport en mémoire pour le protocole de @gamecore/sim : deux ports reliés, comme une page
 * et son Worker, mais dans le même fil d'exécution. Sert aux tests et aux pages sans Worker
 * (mode démo) : le code de la page et celui de l'hôte sont EXACTEMENT ceux de production.
 *
 *   const [pagePort, simPort] = localPort();
 *   exposeSimulation(definition, simPort);
 *   const remote = connectSimulation(pagePort);
 *
 * Comme `postMessage`, la livraison est asynchrone (micro-tâche) et le message est cloné
 * (`structuredClone`, avec transfert) : une donnée non clonable échoue ici comme dans un Worker.
 */

import type { SimPort } from "./protocol.js";

interface LocalPort extends SimPort {
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface LocalPortOptions {
  /** Cloner les messages comme un vrai Worker (oui par défaut). */
  clone?: boolean;
}

/** Crée deux ports reliés : `[côté page, côté simulation]`. */
export function localPort(options: LocalPortOptions = {}): [SimPort, SimPort] {
  const clone = options.clone ?? true;
  const make = (): LocalPort => ({ onmessage: null, postMessage: () => {} });
  const a = make();
  const b = make();
  const link = (from: LocalPort, to: LocalPort) => {
    from.postMessage = (message, opts) => {
      const data = clone
        ? structuredClone(message, opts?.transfer ? { transfer: opts.transfer } : undefined)
        : message;
      queueMicrotask(() => to.onmessage?.({ data }));
    };
  };
  link(a, b);
  link(b, a);
  return [a, b];
}
