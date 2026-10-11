/**
 * Le jeu lancé DANS Discord (Activity, dans un salon vocal).
 *
 * Pas d'écran partagé ici : chaque participant voit le jeu dans sa propre fenêtre Discord.
 * Tout le monde rejoint automatiquement le salon de l'instance (créé par le premier
 * arrivé, qui en devient l'host), avec son identité Discord — sans code ni pseudo à saisir.
 */

import { GameError } from "@gamecore/client";
import { discordDisplayName } from "@gamecore/discord";
import {
  inviteToActivity,
  startDiscordActivity,
  type DiscordActivitySession,
} from "@gamecore/discord/client";
import { useDiscordPresence } from "@gamecore/discord/react";
import { useGame, useGameClient, useMe, useRoom } from "@gamecore/react";
import { useEffect, useState } from "react";
import { API_PREFIX, useConfig } from "../config.js";
import type { Buzzer } from "../game.js";
import { buzzerPresence } from "../presence.js";
import { Notice } from "../ui/Notice.js";
import { Phone } from "./Phone.js";

/** L'initialisation n'a lieu qu'une fois par chargement (le SDK n'aime pas être lancé deux fois). */
let starting: Promise<DiscordActivitySession> | null = null;

export function DiscordActivity() {
  const config = useConfig();
  const client = useGameClient<Buzzer>();
  const [state, setState] = useState<{ session: DiscordActivitySession } | { error: string } | null>(null);

  useEffect(() => {
    if (!config.discord) return;
    const { clientId } = config.discord;
    starting ??= startDiscordActivity({ clientId, tokenEndpoint: `${API_PREFIX}/api/discord/token` }).then(
      async (session) => {
        await client.join(
          session.roomCode,
          { name: discordDisplayName(session.user) },
          { credential: session.accessToken, create: true },
        );
        return session;
      },
    );
    starting
      .then((session) => setState({ session }))
      .catch((err: unknown) => {
        starting = null;
        setState({
          error: err instanceof GameError || err instanceof Error ? err.message : "Erreur inattendue.",
        });
      });
  }, [client, config]);

  if (!config.discord)
    return <Notice title="Discord n'est pas configuré">Ce serveur n'a pas d'application Discord.</Notice>;
  if (state && "error" in state) return <Notice title="Connexion à Discord impossible">{state.error}</Notice>;
  if (!state) {
    return (
      <main className="page page-center">
        <p className="loading">Connexion à Discord…</p>
      </main>
    );
  }
  return (
    <>
      <ActivityPresence session={state.session} />
      <Phone code={state.session.roomCode} />
      <button className="btn btn-ghost invite-button" onClick={() => void inviteToActivity(state.session)}>
        ✉️ Inviter des amis
      </button>
    </>
  );
}

/** Rich Presence : Discord affiche où en est le joueur (question, score, rang). */
function ActivityPresence({ session }: { session: DiscordActivitySession }) {
  const room = useRoom<Buzzer>();
  const game = useGame<Buzzer>();
  const me = useMe();
  useDiscordPresence(session.sdk, buzzerPresence(room, game?.public ?? null, me));
  return null;
}
