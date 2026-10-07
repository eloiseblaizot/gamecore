/**
 * Fournit un `GameClient` à l'arbre React.
 *
 *   const client = new GameClient<typeof monJeu>({ transport: socketIoTransport() });
 *   <GameProvider client={client}><App /></GameProvider>
 */

import type { GameClient } from "@gamecore/client";
import type { AnyGame } from "@gamecore/core";
import { createContext, useContext, type ReactNode } from "react";

const GameClientContext = createContext<GameClient<unknown> | null>(null);

export function GameProvider<G>({ client, children }: { client: GameClient<G>; children: ReactNode }) {
  return <GameClientContext value={client}>{children}</GameClientContext>;
}

/** Le client du `GameProvider` le plus proche. */
export function useGameClient<G = AnyGame>(): GameClient<G> {
  const client = useContext(GameClientContext);
  if (!client) throw new Error("useGameClient doit être utilisé sous un <GameProvider>.");
  return client;
}
