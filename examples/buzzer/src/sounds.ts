/**
 * Mise en son du Buzzer.
 *
 * L'écran de l'hôte porte la musique et les bruitages « publics » (arrivée d'un joueur,
 * nouvelle question, réponses, chrono, révélation, podium). Les téléphones restent discrets :
 * un son neutre quand on répond, puis son propre résultat, au moment où il devient public.
 */

import type { BuiltinMood } from "@gamecore/audio";
import { useMusicMood, useSfx } from "@gamecore/audio/react";
import type { RoomInfo } from "@gamecore/core";
import { useCountdown, useGameEvent } from "@gamecore/react";
import { useEffect, useRef } from "react";
import type { BuzzerPrivate, BuzzerPublic } from "./game.js";

/** Joue `play()` quand `value` change (pas au premier affichage). */
function useOnChange<T>(value: T, play: (value: T, previous: T) => void): void {
  const previous = useRef(value);
  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    const before = previous.current;
    previous.current = value;
    play(value, before);
  });
}

export function useScreenSounds(room: RoomInfo | null, pub: BuzzerPublic | null): void {
  const play = useSfx();
  const mood: BuiltinMood | null = !room
    ? null
    : room.status === "lobby"
      ? "lobby"
      : pub?.phase === "question"
        ? "game"
        : pub?.phase === "reveal"
          ? "reveal"
          : "victory";
  useMusicMood(mood);

  useOnChange(room?.members.length ?? 0, (count, before) => {
    if (room?.status === "lobby") play(count > before ? "join" : "leave");
  });
  useOnChange(room?.status, (status, before) => {
    if (status === "playing" && before !== "playing") play("start");
  });
  useOnChange(pub ? `${pub.index}:${pub.phase}` : null, () => {
    if (pub?.phase === "question" && pub.index > 0) play("round");
    if (pub?.phase === "reveal")
      play(pub.reveal && Object.values(pub.reveal.gained).some((g) => g > 0) ? "success" : "fail");
    if (pub?.phase === "podium") play("victory");
  });
  useGameEvent("answered", () => play("pop"));

  // Tic-tac pendant les cinq dernières secondes.
  const left = Math.ceil(useCountdown(pub?.phase === "question" ? pub.deadline : null) / 1000);
  useOnChange(left, (seconds) => {
    if (pub?.phase === "question" && seconds > 0 && seconds <= 5) play("tick");
  });
}

export function usePhoneSounds(priv: BuzzerPrivate | null | undefined): void {
  const play = useSfx();
  useOnChange(priv?.myAnswer ?? null, (answer) => {
    if (answer !== null) play("done");
  });
  useOnChange(priv?.result ? (priv.result.correct ? "win" : "lose") : null, (result) => {
    if (result) play(result === "win" ? "success" : "fail");
  });
}
