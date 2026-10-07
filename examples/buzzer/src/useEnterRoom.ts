/**
 * Entrée dans le salon de l'URL, en reprenant la session mémorisée si possible.
 *   - écran : reprise avec le jeton d'administration, sinon écran « spectateur » sans droits ;
 *   - téléphone : reprise du joueur, sinon formulaire pour choisir un pseudo.
 */

import { GameError } from "@gamecore/client";
import { useGameClient } from "@gamecore/react";
import { useEffect, useState } from "react";
import type { Buzzer } from "./game.js";

export type EnterState =
  | { status: "pending" }
  | { status: "needs-join" }
  | { status: "ready" }
  | { status: "error"; error: GameError };

export function useEnterRoom(code: string, as: "screen" | "player"): [EnterState, (s: EnterState) => void] {
  const client = useGameClient<Buzzer>();
  const alreadyIn = client.getState().session?.code === code;
  const [state, setState] = useState<EnterState>(alreadyIn ? { status: "ready" } : { status: "pending" });

  useEffect(() => {
    if (client.getState().session?.code === code) return;
    let cancelled = false;
    (async () => {
      const resumed = await client.resume(code);
      if (resumed) return "ready" as const;
      if (as === "player") return "needs-join" as const;
      await client.watch(code);
      return "ready" as const;
    })()
      .then((status) => !cancelled && setState({ status }))
      .catch((err: unknown) => {
        if (cancelled) return;
        const error =
          err instanceof GameError ? err : new GameError("INTERNAL", "Impossible de rejoindre la partie.");
        setState({ status: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, [client, code, as]);

  return [state, setState];
}

/** Message lisible pour une erreur d'entrée dans un salon. */
export function enterErrorTitle(error: GameError): string {
  switch (error.code) {
    case "NOT_FOUND":
      return "Partie introuvable";
    case "ROOM_FULL":
      return "La partie est complète";
    case "ROOM_LOCKED":
      return "La partie est verrouillée";
    case "RATE_LIMITED":
      return "Trop de tentatives";
    default:
      return "Impossible de rejoindre";
  }
}
