import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rps, type RpsPrivate, type RpsPublic } from "./__fixtures__/rps.js";
import { createTestServer, type TestClient } from "./testing.js";

type Client = TestClient<RpsPublic, RpsPrivate>;

/** Un salon créé par un écran, avec des joueurs déjà entrés. */
async function setup(
  names: string[] = ["Alice", "Bob"],
  options: Parameters<typeof createTestServer>[0] = { game: rps },
) {
  const test = createTestServer(options);
  const screen: Client = test.client();
  const welcome = await screen.create("screen");
  const players: Client[] = [];
  const tokens: string[] = [];
  for (const name of names) {
    const c: Client = test.client();
    const w = await c.join(welcome.code, name);
    players.push(c);
    tokens.push(w.token!);
  }
  return { ...test, screen, code: welcome.code, adminToken: welcome.token!, players, tokens };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("création et entrée dans un salon", () => {
  it("un écran crée le salon et reçoit son jeton d'administration", async () => {
    const { client } = createTestServer({ game: rps });
    const screen = client();
    const welcome = await screen.create("screen");
    expect(welcome.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(welcome.kind).toBe("screen");
    expect(welcome.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sync = screen.sync();
    expect(sync.you).toEqual({ kind: "screen", id: null, isHost: true });
    expect(sync.room).toMatchObject({ code: welcome.code, status: "lobby", screens: 1, members: [] });
    expect(sync.room.game).toEqual({
      id: "rps",
      name: "Pierre-feuille-ciseaux",
      minPlayers: 2,
      maxPlayers: 4,
    });
  });

  it("un joueur peut créer le salon et en devient l'host", async () => {
    const { client } = createTestServer({ game: rps });
    const alice = client();
    const welcome = await alice.create("player", "Alice");
    expect(welcome).toMatchObject({
      kind: "player",
      memberId: expect.any(String),
      token: expect.any(String),
    });
    expect(alice.sync().you).toEqual({ kind: "player", id: welcome.memberId, isHost: true });
  });

  it("le premier joueur devient host, les pseudos sont nettoyés et dédoublonnés", async () => {
    const { players, screen } = await setup(["  Alice‮ ", "alice", "Bob"]);
    const members = screen.sync().room.members;
    expect(members.map((m) => m.name)).toEqual(["Alice", "alice 2", "Bob"]);
    expect(members.map((m) => m.isHost)).toEqual([true, false, false]);
    expect(players[1]!.sync().you.isHost).toBe(false);
  });

  it("refuse un pseudo vide et filtre les avatars dangereux", async () => {
    const { client, code } = await setup([]);
    const c = client();
    expect(await c.expectError({ t: "join", code, profile: { name: " ​ " } })).toBe("BAD_REQUEST");
    await c.join(code, "Zoé", { avatar: "https://evil.example/track.png" });
    expect(c.sync().room.members[0]!.avatar).toBeNull();
  });

  it("répond NOT_FOUND pour un code inconnu", async () => {
    const { client } = createTestServer({ game: rps });
    expect(await client().expectError({ t: "join", code: "ZZZZZZ", profile: { name: "x" } })).toBe(
      "NOT_FOUND",
    );
  });

  it("place les joueurs en trop, et ceux qui arrivent en pleine partie, en spectateurs", async () => {
    const { client, code, screen } = await setup(["A", "B", "C", "D"]);
    const late = client();
    expect((await late.join(code, "E")).kind).toBe("spectator");
    await screen.lobby({ op: "start" });
    const later = client();
    expect((await later.join(code, "F")).kind).toBe("spectator");
  });
});

describe("rôle d'host", () => {
  it("réserve les opérations de salon à l'host et à l'écran administrateur", async () => {
    const { players, screen } = await setup();
    expect(await players[1]!.expectError({ t: "lobby", op: { op: "start" } })).toBe("FORBIDDEN");
    expect(await players[1]!.expectError({ t: "lobby", op: { op: "lock", locked: true } })).toBe("FORBIDDEN");
    await players[0]!.lobby({ op: "lock", locked: true });
    await screen.lobby({ op: "lock", locked: false });
  });

  it("un écran anonyme voit la partie mais n'a aucun droit", async () => {
    const { client, code } = await setup();
    const tv = client();
    await tv.watch(code);
    expect(tv.sync().you).toEqual({ kind: "screen", id: null, isHost: false });
    expect(await tv.expectError({ t: "lobby", op: { op: "start" } })).toBe("FORBIDDEN");
  });

  it("refuse un faux jeton d'administration", async () => {
    const { client, code } = await setup();
    expect(await client().expectError({ t: "watch", code, adminToken: "x".repeat(43) })).toBe("UNAUTHORIZED");
  });

  it("transmet le rôle d'host, et le réattribue quand l'host part", async () => {
    const { players, screen } = await setup(["Alice", "Bob", "Chloé"]);
    const ids = screen.sync().room.members.map((m) => m.id);
    await players[0]!.lobby({ op: "promote", memberId: ids[1]! });
    expect(screen.sync().room.hostId).toBe(ids[1]);
    await players[1]!.request({ t: "leave" });
    expect(screen.sync().room.hostId).toBe(ids[0]);
  });

  it("verrouille le salon", async () => {
    const { players, client, code } = await setup();
    await players[0]!.lobby({ op: "lock", locked: true });
    expect(await client().expectError({ t: "join", code, profile: { name: "Intrus" } })).toBe("ROOM_LOCKED");
  });

  it("expulse un membre : il est prévenu et son jeton ne marche plus", async () => {
    const { players, client, code, screen, tokens } = await setup();
    const bobId = screen.sync().room.members[1]!.id;
    await players[0]!.lobby({ op: "kick", memberId: bobId });
    expect(players[1]!.messages("bye")).toEqual([{ t: "bye", reason: "kicked" }]);
    expect(screen.sync().room.members.map((m) => m.name)).toEqual(["Alice"]);
    expect(await client().expectError({ t: "resume", code, token: tokens[1]! })).toBe("UNAUTHORIZED");
    expect(await players[1]!.expectError({ t: "action", action: { type: "next" } })).toBe("BAD_REQUEST");
  });

  it("valide les réglages et les fige pendant la partie", async () => {
    const { screen } = await setup();
    await screen.lobby({ op: "settings", settings: { rounds: 5 } });
    expect(screen.sync().room.settings).toEqual({ rounds: 5, turnMs: 10_000 });
    expect(await screen.expectError({ t: "lobby", op: { op: "settings", settings: { rounds: 99 } } })).toBe(
      "BAD_REQUEST",
    );
    expect(await screen.expectError({ t: "lobby", op: { op: "settings", settings: { admin: true } } })).toBe(
      "BAD_REQUEST",
    );
    await screen.lobby({ op: "start" });
    expect(await screen.expectError({ t: "lobby", op: { op: "settings", settings: { rounds: 1 } } })).toBe(
      "GAME_RUNNING",
    );
  });

  it("change de rôle dans le salon d'attente, dans la limite des places", async () => {
    const { players, client, code, screen } = await setup(["A", "B", "C", "D"]);
    const e = client();
    await e.join(code, "E");
    expect(await e.expectError({ t: "lobby", op: { op: "role", role: "player" } })).toBe("ROOM_FULL");
    await players[3]!.lobby({ op: "role", role: "spectator" });
    await e.lobby({ op: "role", role: "player" });
    expect(
      screen
        .sync()
        .room.members.filter((m) => m.role === "player")
        .map((m) => m.name),
    ).toEqual(["A", "B", "C", "E"]);
  });
});

describe("partie", () => {
  it("exige assez de joueurs pour démarrer", async () => {
    const { screen } = await setup(["Seul"]);
    expect(await screen.expectError({ t: "lobby", op: { op: "start" } })).toBe("RULE");
  });

  it("ne révèle jamais un choix secret avant la révélation", async () => {
    const { players, screen } = await setup(["Alice", "Bob", "Chloé"]);
    const [alice, bob, chloe] = players as [Client, Client, Client];
    await screen.lobby({ op: "start" });
    bob.clear();
    screen.clear();
    await alice.act({ type: "choose", choice: "scissors" });

    expect(alice.sync().game?.private).toEqual({ myChoice: "scissors" });
    expect(bob.sync().game?.private).toEqual({ myChoice: null });
    expect(screen.sync().game?.private).toBeUndefined();
    expect(screen.sync().game?.public.chosen).toHaveLength(1);
    // Rien de ce qu'ont reçu Bob ou l'écran ne contient le choix d'Alice.
    expect(JSON.stringify(bob.conn.received)).not.toContain("scissors");
    expect(JSON.stringify(screen.conn.received)).not.toContain("scissors");

    await bob.act({ type: "choose", choice: "paper" });
    await chloe.act({ type: "choose", choice: "paper" });
    expect(screen.sync().game?.public.phase).toBe("reveal");
    expect(screen.sync().game?.public.last).toMatchObject({ [alice.sync().you.id!]: "scissors" });
  });

  it("applique les règles du jeu et renvoie leur message", async () => {
    const { players, screen } = await setup();
    await screen.lobby({ op: "start" });
    await players[0]!.act({ type: "choose", choice: "rock" });
    await expect(players[0]!.act({ type: "choose", choice: "paper" })).rejects.toMatchObject({
      code: "RULE",
      message: "Tu as déjà choisi.",
    });
    expect(await players[1]!.expectError({ t: "action", action: { type: "next" } })).toBe("FORBIDDEN");
  });

  it("refuse les actions mal formées et les actions système envoyées par un client", async () => {
    const { players, screen } = await setup();
    await screen.lobby({ op: "start" });
    expect(await players[0]!.expectError({ t: "action", action: { type: "timeout" } })).toBe("BAD_REQUEST");
    expect(await players[0]!.expectError({ t: "action", action: { type: "choose", choice: "lizard" } })).toBe(
      "BAD_REQUEST",
    );
  });

  it("refuse les actions des spectateurs et hors partie", async () => {
    const { players, client, code, screen } = await setup();
    expect(await players[0]!.expectError({ t: "action", action: { type: "next" } })).toBe("NOT_PLAYING");
    await screen.lobby({ op: "start" });
    const spectator = client();
    await spectator.join(code, "Curieux");
    expect(await spectator.expectError({ t: "action", action: { type: "choose", choice: "rock" } })).toBe(
      "FORBIDDEN",
    );
  });

  it("déclenche les actions système programmées (fin du chrono)", async () => {
    const { players, screen } = await setup();
    await screen.lobby({ op: "start" });
    await players[0]!.act({ type: "choose", choice: "rock" });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(screen.sync().game?.public.phase).toBe("choosing");
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.sync().game?.public.phase).toBe("reveal");
    expect(Object.values(screen.sync().game!.public.last!)).toHaveLength(2);
  });

  it("annule un minuteur quand le jeu le demande", async () => {
    const { players, screen } = await setup();
    await screen.lobby({ op: "start" });
    await players[0]!.act({ type: "choose", choice: "rock" });
    await players[1]!.act({ type: "choose", choice: "rock" });
    const version = screen.sync().version;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen.sync().version).toBe(version);
  });

  it("envoie les événements du jeu à leurs seuls destinataires", async () => {
    const { players, screen } = await setup();
    await screen.lobby({ op: "start" });
    await players[0]!.act({ type: "choose", choice: "rock" });
    expect(screen.messages("event").map((e) => e.name)).toEqual(["chosen"]);
    expect(players[1]!.messages("event")).toEqual([]);
  });

  it("termine la partie, permet une revanche puis le retour au salon", async () => {
    const { players, screen } = await setup();
    await screen.lobby({ op: "settings", settings: { rounds: 1 } });
    await screen.lobby({ op: "start" });
    await players[0]!.act({ type: "choose", choice: "rock" });
    await players[1]!.act({ type: "choose", choice: "paper" });
    await screen.act({ type: "next" });
    expect(screen.sync().room.status).toBe("finished");
    expect(await players[0]!.expectError({ t: "action", action: { type: "next" } })).toBe("NOT_PLAYING");
    await screen.lobby({ op: "start" });
    expect(screen.sync().game?.public).toMatchObject({ round: 1, phase: "choosing" });
    await screen.lobby({ op: "end" });
    expect(screen.sync()).toMatchObject({ room: { status: "lobby" }, game: null });
  });

  it("masque les erreurs internes du jeu et les journalise côté serveur", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { players, screen } = await setup(["A", "B"], { game: rps, logger });
    await screen.lobby({ op: "start" });
    const before = screen.sync().version;
    await expect(players[0]!.act({ type: "boom" })).rejects.toMatchObject({ code: "INTERNAL" });
    expect(JSON.stringify(players[0]!.conn.received)).not.toContain("10.0.0.12");
    expect(logger.error).toHaveBeenCalledWith(
      "erreur dans le code du jeu",
      expect.objectContaining({ game: "rps" }),
    );
    expect(screen.sync().version).toBe(before);
  });

  it("retire proprement un joueur qui quitte la partie", async () => {
    const { players, screen } = await setup(["A", "B", "C"]);
    await screen.lobby({ op: "start" });
    await players[0]!.act({ type: "choose", choice: "rock" });
    await players[1]!.act({ type: "choose", choice: "rock" });
    await players[2]!.request({ t: "leave" });
    expect(players[2]!.messages("bye")).toEqual([{ t: "bye", reason: "left" }]);
    expect(screen.sync().game?.public.phase).toBe("reveal");
    expect(Object.keys(screen.sync().game!.public.scores)).toHaveLength(2);
  });
});

describe("déconnexions et reprise de session", () => {
  it("reprend sa place avec son jeton après une coupure", async () => {
    const { players, client, code, screen, tokens } = await setup();
    const aliceId = screen.sync().room.members[0]!.id;
    players[0]!.disconnect();
    expect(screen.sync().room.members[0]!.connected).toBe(false);
    const again = client();
    const welcome = await again.resume(code, tokens[0]!);
    expect(welcome).toEqual({ code, kind: "player", memberId: aliceId });
    expect(screen.sync().room.members[0]).toMatchObject({ id: aliceId, connected: true, isHost: true });
  });

  it("refuse un jeton inconnu", async () => {
    const { client, code } = await setup();
    expect(await client().expectError({ t: "resume", code, token: "a".repeat(43) })).toBe("UNAUTHORIZED");
  });

  it("remplace une ancienne connexion du même membre", async () => {
    const { players, client, code, tokens } = await setup();
    const tab2 = client();
    await tab2.resume(code, tokens[0]!);
    expect(players[0]!.messages("bye")).toEqual([{ t: "bye", reason: "replaced" }]);
    expect(await players[0]!.expectError({ t: "lobby", op: { op: "start" } })).toBe("BAD_REQUEST");
  });

  it("libère la place d'un absent dans le salon d'attente après le délai de grâce", async () => {
    const { players, screen } = await setup(["Alice", "Bob"], { game: rps, lobbyGraceMs: 30_000 });
    players[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(screen.sync().room.members).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(screen.sync().room.members.map((m) => m.name)).toEqual(["Bob"]);
    expect(screen.sync().room.members[0]!.isHost).toBe(true);
  });

  it("garde la place d'un joueur déconnecté pendant la partie", async () => {
    const { players, client, code, screen, tokens } = await setup(["Alice", "Bob"], {
      game: rps,
      lobbyGraceMs: 1000,
    });
    await screen.lobby({ op: "start" });
    players[1]!.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.sync().room.members).toHaveLength(2);
    const bob = client();
    await bob.resume(code, tokens[1]!);
    expect(bob.sync().you.kind).toBe("player");
    expect(bob.sync().game?.private).toEqual({ myChoice: null });
  });

  it("ferme un salon resté vide", async () => {
    const { server, players, screen, code } = await setup(["Alice", "Bob"], {
      game: rps,
      emptyRoomTtlMs: 60_000,
    });
    for (const c of [screen, ...players]) c.disconnect();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(server.getRoom(code)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.getRoom(code)).toBeUndefined();
  });

  it("ne ferme pas un salon qui retrouve du monde", async () => {
    const { server, client, players, screen, code, tokens } = await setup(["Alice", "Bob"], {
      game: rps,
      emptyRoomTtlMs: 60_000,
      lobbyGraceMs: 600_000,
    });
    for (const c of [screen, ...players]) c.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    await client().resume(code, tokens[0]!);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.getRoom(code)).toBeDefined();
  });
});

describe("identités vérifiées", () => {
  const authenticate = vi.fn(async (credential: string) =>
    credential.startsWith("ok:")
      ? {
          provider: "discord",
          externalId: credential.slice(3),
          name: `Discord ${credential.slice(3)}`,
          avatar: "https://cdn.discordapp.com/avatars/1/a.png",
        }
      : null,
  );

  it("utilise l'identité vérifiée et retrouve le même membre à la reconnexion", async () => {
    const { client, code, screen } = await setup([], { game: rps, authenticate });
    const a = client();
    const first = await a.request<{ memberId: string }>({
      t: "join",
      code,
      profile: { name: "ignoré" },
      credential: "ok:42",
    });
    expect(screen.sync().room.members[0]).toMatchObject({ name: "Discord 42", provider: "discord" });
    const again = await client().request<{ memberId: string }>({
      t: "join",
      code,
      profile: { name: "x" },
      credential: "ok:42",
    });
    expect(again.memberId).toBe(first.memberId);
    expect(screen.sync().room.members).toHaveLength(1);
  });

  it("refuse une preuve invalide et bannit un compte expulsé", async () => {
    const { client, code, screen } = await setup([], { game: rps, authenticate });
    expect(await client().expectError({ t: "join", code, profile: { name: "x" }, credential: "faux" })).toBe(
      "UNAUTHORIZED",
    );
    const troll = client();
    await troll.request({ t: "join", code, profile: { name: "x" }, credential: "ok:666" });
    await screen.lobby({ op: "kick", memberId: screen.sync().room.members[0]!.id });
    expect(
      await client().expectError({ t: "join", code, profile: { name: "x" }, credential: "ok:666" }),
    ).toBe("FORBIDDEN");
  });

  it("peut exiger un compte", async () => {
    const { client, code } = await setup([], { game: rps, authenticate, requireAuth: true });
    expect(await client().expectError({ t: "join", code, profile: { name: "Invité" } })).toBe("UNAUTHORIZED");
  });
});
