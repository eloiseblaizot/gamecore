/**
 * Hooks d'état et d'évènements.
 *
 * Tous s'appuient sur `useSyncExternalStore` : un composant ne se réaffiche que si la
 * partie de l'état qu'il lit a changé. Un sélecteur doit renvoyer une valeur EXISTANTE de
 * l'état (ou une valeur simple), jamais un nouvel objet calculé à chaque appel.
 */

import type { ClientState } from "@gamecore/client";
import type { AnyGame, ChatMessage, MemberInfo } from "@gamecore/core";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { useGameClient } from "./context.js";

/** Lit une partie de l'état du client. */
export function useClientState<G = AnyGame, T = unknown>(selector: (state: ClientState<G>) => T): T {
  const client = useGameClient<G>();
  const read = () => selector(client.getState());
  return useSyncExternalStore(client.subscribe, read, read);
}

/** État de la connexion : « connecting », « connected », « reconnecting »… */
export const useConnectionStatus = () => useClientState((s) => s.status);

/** Le salon (membres, réglages, statut…), ou `null` hors salon. */
export const useRoom = <G = AnyGame>() => useClientState<G, ClientState<G>["room"]>((s) => s.room);

/** La partie vue par moi (`public` + `private` si je joue), ou `null` hors partie. */
export const useGame = <G = AnyGame>() => useClientState<G, ClientState<G>["game"]>((s) => s.game);

/** Qui je suis pour le serveur (joueur, spectateur, écran ; host ou non). */
export const useYou = () => useClientState((s) => s.you);

/** Suis-je l'host (ou un écran administrateur) ? */
export const useIsHost = () => useClientState((s) => s.you?.isHost ?? false);

/** Ma fiche de membre (pseudo, avatar, rôle), ou `null` pour un écran. */
export function useMe(): MemberInfo | null {
  const room = useClientState((s) => s.room);
  const id = useClientState((s) => s.you?.id ?? null);
  return room?.members.find((m) => m.id === id) ?? null;
}

/** Réagit à un évènement éphémère du jeu (son, animation…). */
export function useGameEvent(name: string, handler: (data: unknown) => void): void {
  const client = useGameClient();
  const onEvent = useEffectEvent(handler);
  useEffect(() => client.on("event", (n, data) => n === name && onEvent(data)), [client, name]);
}

/** Côté écran : réagit aux entrées de manette des joueurs (module « controller »). */
export function useControllerInput(handler: (from: string, data: unknown) => void): void {
  const client = useGameClient();
  const onInput = useEffectEvent(handler);
  useEffect(() => client.on("input", (from, data) => onInput(from, data)), [client]);
}

/** Messages de chat reçus depuis le montage (les plus récents à la fin), et fonction d'envoi. */
export function useChat(limit = 100): {
  messages: ChatMessage[];
  send: (body: string, channel?: string) => Promise<void>;
} {
  const client = useGameClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  useEffect(
    () =>
      client.on("chat", (message) =>
        setMessages((previous) =>
          previous.some((m) => m.id === message.id) ? previous : [...previous, message].slice(-limit),
        ),
      ),
    [client, limit],
  );
  return { messages, send: (body, channel) => client.chat(body, channel) };
}

/**
 * Millisecondes restantes avant `deadline` (horodatage serveur), mis à jour plusieurs fois
 * par seconde. Utilise l'horloge du serveur estimée par le client : deux téléphones aux
 * horloges décalées affichent le même compte à rebours.
 */
export function useCountdown(deadline: number | null | undefined, intervalMs = 250): number {
  const client = useGameClient();
  const [now, setNow] = useState(() => client.serverNow());
  useEffect(() => {
    if (deadline == null) return;
    const timer = setInterval(() => setNow(client.serverNow()), intervalMs);
    return () => clearInterval(timer);
  }, [client, deadline, intervalMs]);
  return deadline == null ? 0 : Math.max(0, deadline - now);
}
