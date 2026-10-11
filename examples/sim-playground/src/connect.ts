/**
 * Connexion à la simulation : dans un Web Worker (par défaut), ou dans la page elle-même avec
 * `?local=1` (mode démo sans Worker, même protocole grâce à `localPort()`).
 */

import { localPort } from "@gamecore/sim";
import { exposeSimulation } from "@gamecore/sim/worker";
import { connectSimulation, type RemoteSim } from "@gamecore/sim/worker-client";
import { foxesAndRabbits } from "./simulation";

export type EcoRemote = RemoteSim<typeof foxesAndRabbits>;

export interface Connection {
  remote: EcoRemote;
  mode: "worker" | "local";
  close(): void;
}

export function connect(local: boolean): Connection {
  if (local) {
    const [pagePort, simPort] = localPort();
    const exposed = exposeSimulation(foxesAndRabbits, simPort);
    const remote = connectSimulation<typeof foxesAndRabbits>(pagePort);
    return {
      remote,
      mode: "local",
      close() {
        remote.close();
        exposed.close();
      },
    };
  }
  const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), {
    type: "module",
    name: "simulation",
  });
  const remote = connectSimulation<typeof foxesAndRabbits>(worker);
  return {
    remote,
    mode: "worker",
    close() {
      remote.close();
      worker.terminate();
    },
  };
}
