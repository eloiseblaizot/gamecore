import { PROTOCOL_VERSION } from "@gamecore/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rps } from "./__fixtures__/rps.js";
import { createTestServer } from "./testing.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const errors = (c: { messages: (t: "error") => { code: string }[] }) =>
  c.messages("error").map((e) => e.code);

describe("chaîne de sécurité des messages", () => {
  it("rejette les messages trop volumineux sans les analyser", async () => {
    const { client } = createTestServer({ game: rps, limits: { maxMessageBytes: 1024 } });
    const c = client();
    await c.raw(JSON.stringify({ t: "ping", pad: "x".repeat(2000) }));
    // Taille en octets, pas en caractères : 600 emojis = 2400 octets.
    await c.raw(JSON.stringify({ t: "chat", body: "🦊".repeat(600) }));
    expect(errors(c)).toEqual(["PAYLOAD_TOO_LARGE", "PAYLOAD_TOO_LARGE"]);
  });

  it("rejette le binaire, le JSON invalide et les messages hors protocole", async () => {
    const { client } = createTestServer({ game: rps });
    const c = client();
    await c.raw(new Uint8Array([1, 2, 3]));
    await c.raw("{pas du json");
    await c.raw(JSON.stringify({ t: "ping", id: 7, extra: "champ inconnu" }));
    await c.raw(JSON.stringify({ t: "create", as: "screen", v: PROTOCOL_VERSION + 1 }));
    await c.raw(JSON.stringify({ t: "__proto__" }));
    expect(errors(c)).toEqual(["BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST"]);
    // L'identifiant de requête est renvoyé même pour un message invalide.
    expect(c.messages("error")[2]).toMatchObject({ ref: 7 });
  });

  it("limite le débit puis ferme la connexion en cas d'abus répété", async () => {
    const { client } = createTestServer({
      game: rps,
      limits: { messagesPerSecond: 2, messageBurst: 3, inputsPerSecond: 0 },
      maxViolationsPerMinute: 3,
    });
    const c = client();
    for (let i = 0; i < 3; i++) await c.request({ t: "ping" });
    await c.raw(JSON.stringify({ t: "ping" }));
    expect(errors(c)).toEqual(["RATE_LIMITED"]);
    expect(c.conn.closed).toBeNull();
    for (let i = 0; i < 3; i++) await c.raw(JSON.stringify({ t: "ping" }));
    expect(c.conn.closed).toMatchObject({ code: 1008 });
    // Une fois fermée, la connexion est oubliée : plus aucune réponse.
    const count = c.conn.received.length;
    await c.raw(JSON.stringify({ t: "ping", id: 1 }));
    expect(c.conn.received).toHaveLength(count);
  });

  it("laisse passer un débit normal après une pause", async () => {
    const { client } = createTestServer({ game: rps, limits: { messagesPerSecond: 2, messageBurst: 2 } });
    const c = client();
    await c.request({ t: "ping" });
    await c.request({ t: "ping" });
    expect(await c.expectError({ t: "ping" })).toBe("RATE_LIMITED");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(c.request({ t: "ping" })).resolves.toMatchObject({ now: expect.any(Number) });
  });

  it("freine la recherche de codes par force brute, adresse par adresse", async () => {
    const { client } = createTestServer({ game: rps, limits: { failedJoinsPerMinute: 5 } });
    const host = client({ ip: "10.0.0.1" });
    const { code } = await host.create("screen");
    const attacker = client({ ip: "203.0.113.9" });
    for (let i = 0; i < 5; i++) {
      expect(
        await attacker.expectError({ t: "join", code: `AAAA${i + 2}${i + 2}`, profile: { name: "x" } }),
      ).toBe("NOT_FOUND");
    }
    // Même avec le bon code, l'adresse doit patienter…
    expect(await attacker.expectError({ t: "join", code, profile: { name: "x" } })).toBe("RATE_LIMITED");
    // … une nouvelle connexion depuis la même adresse aussi…
    expect(await client({ ip: "203.0.113.9" }).expectError({ t: "join", code, profile: { name: "x" } })).toBe(
      "RATE_LIMITED",
    );
    // … mais pas les autres joueurs.
    await expect(client({ ip: "198.51.100.4" }).join(code, "Léa")).resolves.toMatchObject({ kind: "player" });
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(attacker.join(code, "Repenti")).resolves.toMatchObject({ kind: "player" });
  });

  it("compte aussi les jetons de session invalides comme des tentatives ratées", async () => {
    const { client } = createTestServer({ game: rps, limits: { failedJoinsPerMinute: 2 } });
    const { code } = await client().create("screen");
    const c = client({ ip: "203.0.113.9" });
    await c.expectError({ t: "resume", code, token: "a".repeat(43) });
    await c.expectError({ t: "resume", code, token: "b".repeat(43) });
    expect(await c.expectError({ t: "resume", code, token: "c".repeat(43) })).toBe("RATE_LIMITED");
  });

  it("limite la création de salons par adresse et au total", async () => {
    const { client, server } = createTestServer({ game: rps, roomsPerMinutePerIp: 2, maxRooms: 3 });
    const c = client({ ip: "203.0.113.9" });
    await c.create("screen");
    await c.create("screen");
    expect(await c.expectError({ t: "create", as: "screen" })).toBe("RATE_LIMITED");
    await client({ ip: "198.51.100.4" }).create("screen");
    expect(await client({ ip: "198.51.100.5" }).expectError({ t: "create", as: "screen" })).toBe(
      "RATE_LIMITED",
    );
    expect(server.stats().rooms).toBe(3);
  });

  it("peut interdire la création de salons par les clients", async () => {
    const { client, server } = createTestServer({ game: rps, allowCreate: false });
    expect(await client().expectError({ t: "create", as: "screen" })).toBe("FORBIDDEN");
    const { room } = await server.createRoom();
    await expect(client().join(room.code, "Léa")).resolves.toMatchObject({ kind: "player" });
  });

  it("exige d'être dans un salon pour les messages de salon", async () => {
    const { client } = createTestServer({ game: rps });
    expect(await client().expectError({ t: "lobby", op: { op: "start" } })).toBe("BAD_REQUEST");
    expect(await client().expectError({ t: "action", action: {} })).toBe("BAD_REQUEST");
  });

  it("répond au ping avec l'heure du serveur", async () => {
    vi.setSystemTime(1_700_000_000_000);
    const { client } = createTestServer({ game: rps });
    await expect(client().request({ t: "ping" })).resolves.toEqual({ now: 1_700_000_000_000 });
  });
});

describe("administration", () => {
  it("crée un salon avec un code imposé (PartyKit) et refuse les doublons", async () => {
    const { server } = createTestServer({ game: rps });
    const { room } = await server.createRoom({ code: "abcd-ef" });
    expect(room.code).toBe("ABCDEF");
    await expect(server.createRoom({ code: "ABCDEF" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(server.createRoom({ code: "0000" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("ferme un salon en prévenant tout le monde", async () => {
    const { server, client } = createTestServer({ game: rps });
    const screen = client();
    const { code } = await screen.create("screen");
    server.closeRoom(code);
    expect(screen.messages("bye")).toEqual([{ t: "bye", reason: "closed" }]);
    expect(server.getRoom(code)).toBeUndefined();
    expect(await screen.expectError({ t: "lobby", op: { op: "start" } })).toBe("BAD_REQUEST");
  });

  it("refuse deux modules homonymes", async () => {
    const { GameServer } = await import("./server.js");
    const { chatModule } = await import("./modules/chat.js");
    expect(() => new GameServer({ game: rps, modules: [chatModule(), chatModule()] })).toThrow(/même nom/);
  });
});
