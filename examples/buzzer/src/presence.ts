/**
 * Rich Presence du Buzzer (Discord Activity) : ce que les amis du joueur voient sous son nom.
 * Uniquement de l'information publique (numéro de question, score, rang) — jamais de réponse.
 */

import type { MemberInfo, RoomInfo } from "@gamecore/core";
import type { Presence } from "@gamecore/discord";
import type { BuzzerPublic } from "./game.js";

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

export function buzzerPresence(
  room: RoomInfo | null,
  pub: BuzzerPublic | null,
  me: MemberInfo | null,
): Presence | null {
  if (!room) return null;
  const players = room.members.filter((m) => m.role === "player").length;
  const base: Presence = {
    largeImage: "buzzer",
    largeText: "Buzzer !",
    party: { id: room.code, size: players, max: room.game.maxPlayers },
  };
  if (room.status === "lobby" || !pub) {
    return { ...base, details: "Dans le salon d'attente", state: plural(players, "joueur") };
  }
  const score = me ? (pub.scores[me.id] ?? 0) : null;
  if (pub.phase === "podium") {
    const rank = pub.ranking.find((r) => r.id === me?.id)?.rank;
    return {
      ...base,
      details: "Partie terminée",
      state: rank ? `${rank === 1 ? "1er" : `${rank}e`} sur ${pub.ranking.length}` : "Podium",
    };
  }
  return {
    ...base,
    details: `Question ${pub.index + 1} / ${pub.total}`,
    state: score === null ? "Spectateur" : plural(score, "point"),
    endsAt: pub.phase === "question" ? pub.deadline : undefined,
  };
}
