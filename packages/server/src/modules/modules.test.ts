import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { rps, type RpsState } from "../__fixtures__/rps.js";
import { createTestServer } from "../testing.js";
import { chatModule } from "./chat.js";
import { controllerModule } from "./controller.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function room(modules: Parameters<typeof createTestServer>[0]["modules"], names = ["Alice", "Bob"]) {
  const test = createTestServer({ game: rps, modules });
  const screen = test.client();
  const { code } = await screen.create("screen");
  const players = [];
  const tokens: string[] = [];
  for (const name of names) {
    const c = test.client();
    tokens.push((await c.join(code, name)).token!);
    players.push(c);
  }
  const ids = screen.sync().room.members.map((m) => m.id);
  return { ...test, screen, code, players, ids, tokens };
}

describe("module manettes", () => {
  const joystick = z.strictObject({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) });

  it("relaie les entrées des joueurs aux écrans uniquement", async () => {
    const { screen, players, ids } = await room([controllerModule({ schema: joystick })]);
    await players[0]!.raw(JSON.stringify({ t: "input", data: { x: 0.5, y: -1 } }));
    expect(screen.messages("input")).toEqual([{ t: "input", from: ids[0], data: { x: 0.5, y: -1 } }]);
    expect(players[1]!.messages("input")).toEqual([]);
    expect(screen.sync().room.modules).toEqual(["controller"]);
  });

  it("valide les entrées avec le schéma du jeu", async () => {
    const { screen, players } = await room([controllerModule({ schema: joystick })]);
    await players[0]!.raw(JSON.stringify({ t: "input", data: { x: 5, y: 0 } }));
    expect(players[0]!.messages("error").map((e) => e.code)).toEqual(["BAD_REQUEST"]);
    expect(screen.messages("input")).toEqual([]);
  });

  it("ignore silencieusement les entrées au-delà du débit autorisé", async () => {
    const { screen, players } = await room([controllerModule({ inputsPerSecond: 10 })]);
    for (let i = 0; i < 20; i++) await players[0]!.raw(JSON.stringify({ t: "input", data: i }));
    expect(screen.messages("input")).toHaveLength(5);
    expect(players[0]!.messages("error")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await players[0]!.raw(JSON.stringify({ t: "input", data: "encore" }));
    expect(screen.messages("input")).toHaveLength(6);
  });

  it("refuse les entrées des écrans et des spectateurs", async () => {
    const { screen, client, code } = await room([controllerModule()]);
    await screen.raw(JSON.stringify({ t: "input", data: 1 }));
    const spectator = client();
    await spectator.join(code, "Curieux", { spectator: true });
    await spectator.raw(JSON.stringify({ t: "input", data: 1 }));
    expect(screen.messages("error").map((e) => e.code)).toEqual(["FORBIDDEN"]);
    expect(spectator.messages("error").map((e) => e.code)).toEqual(["FORBIDDEN"]);
  });

  it("répond MODULE_DISABLED quand le module n'est pas activé", async () => {
    const { players } = await room([]);
    expect(await players[0]!.expectError({ t: "chat", body: "salut" })).toBe("MODULE_DISABLED");
    await players[0]!.raw(JSON.stringify({ t: "input", data: 1 }));
    expect(players[0]!.messages("error").map((e) => e.code)).toEqual(["MODULE_DISABLED", "MODULE_DISABLED"]);
  });
});

describe("module chat", () => {
  it("diffuse un message nettoyé à tout le salon, écrans compris", async () => {
    const { screen, players, ids } = await room([chatModule()]);
    await players[0]!.request({ t: "chat", body: "  salut‮  tout\nle monde " });
    const expected = { id: 1, from: ids[0], name: "Alice", channel: "all", body: "salut tout le monde" };
    for (const c of [screen, ...players]) expect(c.messages("chat")[0]?.message).toMatchObject(expected);
  });

  it("refuse les messages vides, les écrans, et les rafales", async () => {
    const { screen, players } = await room([chatModule({ messagesPer10s: 2 })]);
    expect(await players[0]!.expectError({ t: "chat", body: " ​ " })).toBe("BAD_REQUEST");
    expect(await screen.expectError({ t: "chat", body: "coucou" })).toBe("FORBIDDEN");
    await players[0]!.request({ t: "chat", body: "1" });
    await players[0]!.request({ t: "chat", body: "2" });
    expect(await players[0]!.expectError({ t: "chat", body: "3" })).toBe("RATE_LIMITED");
  });

  it("tronque les messages trop longs et refuse les canaux inconnus", async () => {
    const { players } = await room([chatModule({ maxLength: 5 })]);
    await players[0]!.request({ t: "chat", body: "abcdefgh" });
    expect(players[1]!.messages("chat")[0]?.message.body).toBe("abcde");
    expect(await players[0]!.expectError({ t: "chat", channel: "secret", body: "x" })).toBe("FORBIDDEN");
  });

  it("restreint un canal à son audience, même dans l'historique", async () => {
    // Canal « équipe » : réservé aux joueurs qui n'ont pas encore choisi (exemple artificiel).
    const chat = chatModule({
      audience: (channel, sender, ctx) => {
        if (channel === "all") return "all";
        const state = ctx.gameState() as RpsState | null;
        if (!state || sender.memberId === null || state.choices[sender.memberId] !== null) return null;
        return Object.keys(state.choices).filter((id) => state.choices[id] === null);
      },
    });
    const { screen, players, client, code, tokens } = await room([chat], ["Alice", "Bob", "Chloé"]);
    await screen.lobby({ op: "start" });
    await players[2]!.act({ type: "choose", choice: "rock" });
    expect(await players[2]!.expectError({ t: "chat", channel: "équipe", body: "je peux ?" })).toBe(
      "FORBIDDEN",
    );
    await players[0]!.request({ t: "chat", channel: "équipe", body: "chut" });
    expect(players[1]!.messages("chat")).toHaveLength(1);
    expect(players[2]!.messages("chat")).toHaveLength(0);
    expect(screen.messages("chat")).toHaveLength(0);

    // Bob se reconnecte sur un autre appareil : il retrouve le message ; un nouveau venu, non.
    players[1]!.disconnect();
    const bobAgain = client();
    await bobAgain.resume(code, tokens[1]!);
    expect(bobAgain.messages("chat").map((m) => m.message.body)).toEqual(["chut"]);
    const newcomer = client();
    await newcomer.join(code, "Retardataire");
    expect(newcomer.messages("chat")).toHaveLength(0);
  });

  it("envoie l'historique visible à une connexion qui arrive, après la synchronisation", async () => {
    const { screen, players, client, code } = await room([chatModule({ history: 2 })]);
    for (const body of ["un", "deux", "trois"]) await players[0]!.request({ t: "chat", body });
    const late = client();
    await late.join(code, "Retard");
    expect(late.messages("chat").map((m) => m.message.body)).toEqual(["deux", "trois"]);
    const types = late.conn.received.map((m) => m.t);
    expect(types.indexOf("sync")).toBeLessThan(types.indexOf("chat"));
    const tv = client();
    await tv.watch(code);
    expect(tv.messages("chat")).toHaveLength(2);
    expect(screen.messages("chat")).toHaveLength(3);
  });
});
