/**
 * Mode démo : une partie complète dans le navigateur, contre des bots, sans serveur.
 *
 * Chargé à la demande (`import("./demo.js")`) : le serveur gamecore et les questions de la
 * démo ne sont téléchargés que par ceux qui lancent la démo. Les questions du mode en
 * ligne, elles, n'y figurent jamais (banque distincte, voir demo-questions.ts).
 */

import { createDemoRoom } from "@gamecore/client/local";
import { controllerModule } from "@gamecore/server";
import { DEMO_QUESTIONS } from "./demo-questions.js";
import { createBuzzer } from "./game.js";
import { reactionSchema } from "./reactions.js";

export function startDemo(name: string) {
  return createDemoRoom({
    game: createBuzzer(DEMO_QUESTIONS),
    modules: [controllerModule({ schema: reactionSchema, inputsPerSecond: 3, from: "members" })],
    player: { name, avatar: "🦊" },
    bots: 3,
    settings: { questions: 5, seconds: 15 },
  });
}

export type Demo = Awaited<ReturnType<typeof startDemo>>;
