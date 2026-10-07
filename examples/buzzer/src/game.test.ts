import { createTestServer, type TestClient } from "@gamecore/server/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE_POINTS,
  REVEAL_DELAY_MS,
  SPEED_POINTS,
  buzzer,
  pointsFor,
  type BuzzerPrivate,
  type BuzzerPublic,
} from "./game.js";
import { QUESTIONS } from "./questions.js";

type Client = TestClient<BuzzerPublic, BuzzerPrivate>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T20:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function start(
  names = ["Alice", "Bob"],
  settings: Record<string, unknown> = { questions: 2, seconds: 10 },
) {
  const { client } = createTestServer({ game: buzzer });
  const screen: Client = client();
  const { code } = await screen.create("screen", undefined, settings);
  const players: Client[] = [];
  for (const name of names) {
    const c: Client = client();
    await c.join(code, name);
    players.push(c);
  }
  await screen.lobby({ op: "start" });
  return { client, code, screen, players };
}

/** La bonne réponse de la question affichée (le test, lui, a le droit de tricher). */
function correctAnswer(screen: Client): 0 | 1 | 2 | 3 {
  const text = screen.sync().game!.public.question.text;
  return QUESTIONS.find((q) => q.text === text)!.answer;
}

describe("Buzzer !", () => {
  it("affiche la question sans jamais révéler la réponse avant la fin", async () => {
    const { screen, players } = await start();
    const pub = screen.sync().game!.public;
    expect(pub).toMatchObject({ phase: "question", index: 0, total: 2, reveal: null, answered: [] });
    expect(pub.question.choices).toHaveLength(4);
    expect(JSON.stringify(screen.conn.received)).not.toMatch(/"answer"/);
    expect(players[0]!.sync().game!.private).toEqual({ myAnswer: null, result: null });
  });

  it("garde chaque réponse secrète jusqu'à la révélation", async () => {
    const { screen, players } = await start();
    const [alice, bob] = players as [Client, Client];
    const aliceId = alice.sync().you.id!;
    await alice.act({ type: "answer", choice: 3 });
    expect(alice.sync().game!.private!.myAnswer).toBe(3);
    expect(bob.sync().game!.private!.myAnswer).toBeNull();
    expect(screen.sync().game!.public.answered).toEqual([aliceId]);
    expect(screen.sync().game!.public.reveal).toBeNull();
    expect(screen.messages("event")).toEqual([{ t: "event", name: "answered", data: { by: aliceId } }]);
  });

  it("révèle après un court suspense quand tout le monde a répondu, et récompense la rapidité", async () => {
    const { screen, players } = await start();
    const [alice, bob] = players as [Client, Client];
    const good = correctAnswer(screen);
    await alice.act({ type: "answer", choice: good });
    await vi.advanceTimersByTimeAsync(5_000);
    await bob.act({ type: "answer", choice: good });
    expect(screen.sync().game!.public.phase).toBe("question");
    await vi.advanceTimersByTimeAsync(REVEAL_DELAY_MS);

    const pub = screen.sync().game!.public;
    expect(pub.phase).toBe("reveal");
    expect(pub.reveal!.correct).toBe(good);
    expect(pub.reveal!.counts[good]).toBe(2);
    const aliceId = alice.sync().you.id!;
    const bobId = bob.sync().you.id!;
    expect(pub.scores[aliceId]).toBe(1000);
    expect(pub.scores[bobId]).toBe(750);
    expect(pub.ranking.map((r) => [r.name, r.rank])).toEqual([
      ["Alice", 1],
      ["Bob", 2],
    ]);
    expect(alice.sync().game!.private!.result).toEqual({ correct: true, gained: 1000 });
  });

  it("ne donne aucun point pour une mauvaise réponse ou une absence de réponse", async () => {
    const { screen, players } = await start();
    const [alice] = players as [Client, Client];
    const bad = ((correctAnswer(screen) + 1) % 4) as 0 | 1 | 2 | 3;
    await alice.act({ type: "answer", choice: bad });
    await vi.advanceTimersByTimeAsync(10_000);
    const pub = screen.sync().game!.public;
    expect(pub.phase).toBe("reveal");
    expect(Object.values(pub.scores)).toEqual([0, 0]);
    expect(alice.sync().game!.private!.result).toEqual({ correct: false, gained: 0 });
  });

  it("refuse les réponses en double, hors délai ou des spectateurs", async () => {
    const { screen, players, client, code } = await start(["Alice", "Bob"]);
    await players[0]!.act({ type: "answer", choice: 0 });
    await expect(players[0]!.act({ type: "answer", choice: 1 })).rejects.toMatchObject({
      message: "Tu as déjà répondu.",
    });
    const spectator: Client = client();
    await spectator.join(code, "Curieux");
    expect(await spectator.expectError({ t: "action", action: { type: "answer", choice: 0 } })).toBe(
      "FORBIDDEN",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(players[1]!.act({ type: "answer", choice: 0 })).rejects.toMatchObject({
      message: "Les réponses sont fermées.",
    });
    expect(screen.sync().game!.public.phase).toBe("reveal");
  });

  it("enchaîne les questions sur ordre de l'host, puis termine sur le podium", async () => {
    const { screen, players } = await start(["Alice", "Bob"], { questions: 2, seconds: 10 });
    expect(await players[1]!.expectError({ t: "action", action: { type: "next" } })).toBe("FORBIDDEN");
    await expect(screen.act({ type: "next" })).rejects.toMatchObject({ code: "RULE" });
    await vi.advanceTimersByTimeAsync(10_000);
    await screen.act({ type: "next" });
    expect(screen.sync().game!.public).toMatchObject({ phase: "question", index: 1, answered: [] });
    await vi.advanceTimersByTimeAsync(10_000);
    await players[0]!.act({ type: "next" }); // le premier joueur est host (VIP) lui aussi
    expect(screen.sync().room.status).toBe("finished");
    expect(screen.sync().game!.public.phase).toBe("podium");
  });

  it("ignore un chrono périmé d'une question précédente", async () => {
    const { screen, players } = await start(["Alice"], { questions: 3, seconds: 10 });
    await players[0]!.act({ type: "answer", choice: correctAnswer(screen) });
    await vi.advanceTimersByTimeAsync(REVEAL_DELAY_MS);
    await screen.act({ type: "next" });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(screen.sync().game!.public).toMatchObject({ phase: "question", index: 1 });
  });

  it("pose des questions différentes et valide les réglages", async () => {
    const { screen } = await start(["Alice"], { questions: 5, seconds: 20 });
    expect(screen.sync().game!.public).toMatchObject({ total: 5, duration: 20_000 });
    const { client } = createTestServer({ game: buzzer });
    const tv = client();
    const { code } = await tv.create("screen");
    expect(await tv.expectError({ t: "lobby", op: { op: "settings", settings: { questions: 0 } } })).toBe(
      "BAD_REQUEST",
    );
    expect(await tv.expectError({ t: "lobby", op: { op: "settings", settings: { seconds: 2 } } })).toBe(
      "BAD_REQUEST",
    );
    expect(code).toBeTruthy();
  });

  it("continue sans un joueur parti", async () => {
    const { screen, players } = await start(["Alice", "Bob"]);
    await players[0]!.act({ type: "answer", choice: 0 });
    await players[1]!.request({ t: "leave" });
    await vi.advanceTimersByTimeAsync(REVEAL_DELAY_MS);
    const pub = screen.sync().game!.public;
    expect(pub.phase).toBe("reveal");
    expect(pub.ranking).toHaveLength(1);
  });

  it("calcule les points d'une bonne réponse selon la rapidité", () => {
    const s = { startedAt: 0, deadline: 10_000 } as Parameters<typeof pointsFor>[0];
    expect(pointsFor(s, 0)).toBe(BASE_POINTS + SPEED_POINTS);
    expect(pointsFor(s, 5_000)).toBe(750);
    expect(pointsFor(s, 10_000)).toBe(BASE_POINTS);
    // Bornes : jamais plus que le maximum, jamais moins que la base.
    expect(pointsFor(s, -5_000)).toBe(1000);
    expect(pointsFor(s, 20_000)).toBe(500);
  });
});
