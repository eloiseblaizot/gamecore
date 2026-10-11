import type { MemberInfo, RoomInfo } from "@gamecore/core";
import { describe, expect, it } from "vitest";
import type { BuzzerPublic } from "./game.js";
import { buzzerPresence } from "./presence.js";

const member = (id: string, role: "player" | "spectator" = "player"): MemberInfo => ({
  id,
  name: id,
  avatar: null,
  role,
  connected: true,
  isHost: false,
  provider: "discord",
});
const room = (status: RoomInfo["status"], members: MemberInfo[]): RoomInfo =>
  ({ code: "ABCDEFGHJKLM", status, members, game: { maxPlayers: 12 } }) as RoomInfo;
const pub = (extra: Partial<BuzzerPublic>): BuzzerPublic =>
  ({
    phase: "question",
    index: 2,
    total: 5,
    deadline: 99_000,
    scores: { a: 1200 },
    ranking: [],
    ...extra,
  }) as BuzzerPublic;

describe("Rich Presence du Buzzer", () => {
  it("montre le salon d'attente et la taille du groupe", () => {
    const lobby = room("lobby", [member("a"), member("b"), member("c", "spectator")]);
    expect(buzzerPresence(lobby, null, member("a"))).toEqual({
      largeImage: "buzzer",
      largeText: "Buzzer !",
      party: { id: "ABCDEFGHJKLM", size: 2, max: 12 },
      details: "Dans le salon d'attente",
      state: "2 joueurs",
    });
  });

  it("montre la question en cours, le score et le temps restant", () => {
    const playing = room("playing", [member("a")]);
    expect(buzzerPresence(playing, pub({}), member("a"))).toMatchObject({
      details: "Question 3 / 5",
      state: "1200 points",
      endsAt: 99_000,
    });
    expect(buzzerPresence(playing, pub({ phase: "reveal" }), member("a"))?.endsAt).toBeUndefined();
    expect(buzzerPresence(playing, pub({}), null)?.state).toBe("Spectateur");
  });

  it("montre le rang final", () => {
    const ranking = [
      { id: "b", name: "b", avatar: null, score: 2000, rank: 1 },
      { id: "a", name: "a", avatar: null, score: 1200, rank: 2 },
    ];
    const finished = room("finished", [member("a"), member("b")]);
    expect(buzzerPresence(finished, pub({ phase: "podium", ranking }), member("a"))).toMatchObject({
      details: "Partie terminée",
      state: "2e sur 2",
    });
    expect(buzzerPresence(finished, pub({ phase: "podium", ranking }), member("b"))?.state).toBe("1er sur 2");
  });

  it("ne contient jamais de réponse", () => {
    const presence = buzzerPresence(
      room("playing", [member("a")]),
      pub({ reveal: { correct: 2 } as never }),
      member("a"),
    );
    expect(JSON.stringify(presence)).not.toMatch(/correct|answer/);
    expect(buzzerPresence(null, null, null)).toBeNull();
  });
});
