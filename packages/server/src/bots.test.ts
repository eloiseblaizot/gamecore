import { defineGame, isBot } from "@gamecore/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHOICES, rps, type RpsPrivate, type RpsPublic } from "./__fixtures__/rps.js";
import { createTestServer, type TestClient } from "./testing.js";

type Client = TestClient<RpsPublic, RpsPrivate>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function room(options: Partial<Parameters<typeof createTestServer>[0]> = {}) {
  const test = createTestServer({ game: rps, ...options });
  const screen: Client = test.client();
  const { code } = await screen.create("screen");
  const human: Client = test.client();
  await human.join(code, "Alice");
  return { ...test, screen, human, code };
}

const bots = (c: Client) => c.sync().room.members.filter(isBot);

describe("ajout de bots", () => {
  it("l'host ajoute des bots, joueurs toujours connectés, avec des noms distincts", async () => {
    const { screen } = await room();
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "addBot" });
    expect(bots(screen).map((m) => m.name)).toEqual(["Robot Rouge", "Robot Bleu", "Robot Rouge 2"]);
    for (const bot of bots(screen)) {
      expect(bot).toMatchObject({
        role: "player",
        connected: true,
        isHost: false,
        provider: "bot",
        avatar: "🤖",
      });
    }
  });

  it("réserve l'ajout à l'host, hors partie, dans la limite des places", async () => {
    const { screen, human, client, code } = await room({ maxBotsPerRoom: 2 });
    const guest: Client = client();
    await guest.join(code, "Bob");
    expect(await guest.expectError({ t: "lobby", op: { op: "addBot" } })).toBe("FORBIDDEN");
    await human.lobby({ op: "addBot" });
    await screen.lobby({ op: "addBot" });
    expect(await screen.expectError({ t: "lobby", op: { op: "addBot" } })).toBe("ROOM_FULL");
    await screen.lobby({ op: "start" });
    expect(await screen.expectError({ t: "lobby", op: { op: "addBot" } })).toBe("GAME_RUNNING");
  });

  it("refuse les bots si le jeu n'a pas de stratégie", async () => {
    const { bots: _ignored, ...withoutBots } = rps;
    const { screen } = await room({ game: defineGame(withoutBots) });
    expect(await screen.expectError({ t: "lobby", op: { op: "addBot" } })).toBe("MODULE_DISABLED");
  });

  it("retire un bot comme n'importe quel membre", async () => {
    const { screen } = await room();
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "kick", memberId: bots(screen)[0]!.id });
    expect(bots(screen)).toEqual([]);
  });
});

describe("bots en partie", () => {
  it("jouent tout seuls avec un délai humain, et la partie avance", async () => {
    const { screen, human } = await room();
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "start" });
    expect(screen.sync().game?.public.chosen).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(screen.sync().game?.public.chosen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.sync().game?.public.chosen).toHaveLength(2);
    await human.act({ type: "choose", choice: "rock" });
    const pub = screen.sync().game!.public;
    expect(pub.phase).toBe("reveal");
    for (const bot of bots(screen)) expect(CHOICES).toContain(pub.last![bot.id]);
  });

  it("ne rejouent pas quand ils n'ont rien à faire", async () => {
    const { screen } = await room();
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "start" });
    await vi.advanceTimersByTimeAsync(1000);
    const version = screen.sync().version;
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.sync().version).toBe(version);
  });

  it("ne sont pas sans cesse repoussés par les coups des autres", async () => {
    const slow = defineGame({
      ...rps,
      bots: { ...rps.bots!, delay: () => 3000 },
    });
    const { screen, client, code } = await room({ game: slow });
    const bob: Client = client();
    await bob.join(code, "Bob");
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "start" });
    // Les humains agissent pendant que le bot attend son tour : son coup prévu tient toujours.
    await vi.advanceTimersByTimeAsync(1500);
    await bob.act({ type: "choose", choice: "paper" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(screen.sync().game?.public.chosen).toContain(bots(screen)[0]!.id);
  });

  it("un bot retiré en pleine partie est oublié proprement", async () => {
    const { screen, human } = await room();
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "start" });
    await screen.lobby({ op: "kick", memberId: bots(screen)[0]!.id });
    await vi.advanceTimersByTimeAsync(5000);
    expect(Object.keys(screen.sync().game!.public.scores)).toEqual([human.sync().you.id]);
  });

  it("survit à une stratégie défaillante ou à un coup hors schéma", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const broken = defineGame({
      ...rps,
      bots: {
        decide: (view) => {
          if (view.public.round === 1) throw new Error("bug de stratégie");
          return null;
        },
      },
    });
    const { screen, human } = await room({ game: broken, logger });
    await screen.lobby({ op: "addBot" });
    await screen.lobby({ op: "start" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(logger.error).toHaveBeenCalledWith("erreur dans la stratégie des bots", expect.anything());
    await human.act({ type: "choose", choice: "rock" });

    const cheating = defineGame({
      ...rps,
      bots: { decide: () => ({ type: "timeout" }) as never, delay: () => 10 },
    });
    const other = await room({ game: cheating, logger });
    await other.screen.lobby({ op: "addBot" });
    await other.screen.lobby({ op: "start" });
    await vi.advanceTimersByTimeAsync(100);
    expect(logger.error).toHaveBeenCalledWith("coup de bot hors du schéma des actions", expect.anything());
  });

  it("ne sont jamais host et ne gardent pas un salon vide en vie", async () => {
    const { server, screen, human, code } = await room({ emptyRoomTtlMs: 60_000 });
    await screen.lobby({ op: "addBot" });
    await human.request({ t: "leave" });
    expect(screen.sync().room.hostId).toBeNull();
    screen.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.getRoom(code)).toBeUndefined();
  });

  it("jouent de façon reproductible pour une même graine", async () => {
    async function play(seed: string) {
      const test = createTestServer({ game: rps });
      const { room: r } = await test.server.createRoom({ seed });
      const screen: Client = test.client();
      await screen.watch(r.code);
      const human: Client = test.client();
      await human.join(r.code, "Alice");
      // L'écran sans jeton n'est pas admin : c'est le joueur, host, qui ajoute les bots.
      await human.lobby({ op: "addBot" });
      await human.lobby({ op: "addBot" });
      await human.lobby({ op: "start" });
      await vi.advanceTimersByTimeAsync(1000);
      await human.act({ type: "choose", choice: "rock" });
      const last = screen.sync().game!.public.last!;
      return bots(screen).map((b) => last[b.id]);
    }
    expect(await play("graine")).toEqual(await play("graine"));
  });

  it("une identité vérifiée ne peut pas se faire passer pour un bot", async () => {
    const authenticate = async () => ({ provider: "bot", externalId: "1", name: "Faux bot" });
    const { client, code } = await room({ authenticate });
    expect(await client().expectError({ t: "join", code, profile: { name: "x" }, credential: "x" })).toBe(
      "UNAUTHORIZED",
    );
  });
});
