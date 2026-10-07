import { GameServer, controllerModule, silentLogger } from "@gamecore/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rps } from "../../server/src/__fixtures__/rps.js";
import { GameClient } from "./client.js";
import { localTransport } from "./local.js";
import { memoryStore, type SessionStore } from "./storage.js";
import type { ClientTransport, TransportHandlers } from "./transport.js";

type Rps = typeof rps;

/** Laisse passer les échanges asynchrones du transport local (dont le hachage SHA-256 des jetons). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Transport local dont on peut couper et rétablir le « réseau ». */
function flaky(server: GameServer) {
  let handlers: TransportHandlers | null = null;
  let inner: ClientTransport | null = null;
  const open = () => {
    inner = localTransport(server);
    inner.connect({
      open: () => handlers?.open(),
      message: (d) => handlers?.message(d),
      close: () => handlers?.close(),
    });
  };
  const transport: ClientTransport = {
    connect(h) {
      handlers = h;
      open();
    },
    send: (data) => inner?.send(data),
    close: () => inner?.close(),
  };
  return {
    transport,
    drop() {
      inner?.close();
      inner = null;
      handlers?.close();
    },
    restore: open,
  };
}

function setup() {
  const server = new GameServer({ game: rps, logger: silentLogger, modules: [controllerModule()] });
  const make = (storage: SessionStore | null = memoryStore()) =>
    new GameClient<Rps>({ transport: localTransport(server), storage });
  return { server, make };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GameClient", () => {
  it("crée un salon, fait entrer des joueurs et suit l'état de la partie", async () => {
    const { make } = setup();
    const screen = make();
    const { code } = await screen.create("screen");
    expect(screen.getState()).toMatchObject({
      status: "connected",
      session: { code, kind: "screen", memberId: null },
      you: { kind: "screen", isHost: true },
    });

    const alice = make();
    const bob = make();
    await alice.join(code, { name: "Alice" });
    await bob.join(code, { name: "Bob" });
    await screen.lobby.start();
    await alice.act({ type: "choose", choice: "rock" });
    await settle();

    expect(alice.getState().game?.private).toEqual({ myChoice: "rock" });
    expect(bob.getState().game?.private).toEqual({ myChoice: null });
    expect(screen.getState().game?.public.chosen).toEqual([alice.getState().session!.memberId]);
    expect(screen.getState().room?.members.map((m) => m.name)).toEqual(["Alice", "Bob"]);
  });

  it("rejette une action refusée avec l'erreur du serveur", async () => {
    const { make } = setup();
    const screen = make();
    const { code } = await screen.create("screen");
    const alice = make();
    await alice.join(code, { name: "Alice" });
    await make().join(code, { name: "Bob" });
    await screen.lobby.start();
    await alice.act({ type: "choose", choice: "rock" });
    await expect(alice.act({ type: "choose", choice: "paper" })).rejects.toMatchObject({
      name: "GameError",
      code: "RULE",
      message: "Tu as déjà choisi.",
    });
  });

  it("notifie les abonnés à chaque changement d'état", async () => {
    const { make } = setup();
    const screen = make();
    const listener = vi.fn();
    screen.subscribe(listener);
    const before = screen.getState();
    await screen.create("screen");
    expect(listener).toHaveBeenCalled();
    expect(screen.getState()).not.toBe(before);
  });

  it("reprend sa place après un rechargement de page", async () => {
    const { make } = setup();
    const screen = make();
    const { code } = await screen.create("screen");
    const storage = memoryStore();
    const alice = make(storage);
    const { memberId } = await alice.join(code, { name: "Alice" });
    alice.close();

    // « Rechargement » : nouveau client, même stockage de session.
    const reloaded = make(storage);
    expect(reloaded.stored(code)).toMatchObject({ code, kind: "player" });
    const welcome = await reloaded.resume(code);
    expect(welcome).toMatchObject({ memberId, kind: "player" });
    await settle();
    expect(screen.getState().room?.members).toEqual([
      expect.objectContaining({ id: memberId, connected: true }),
    ]);
  });

  it("l'écran retrouve ses droits d'administration après un rechargement", async () => {
    const { make } = setup();
    const storage = memoryStore();
    const screen = make(storage);
    const { code } = await screen.create("screen");
    screen.close();
    const reloaded = make(storage);
    await reloaded.resume(code);
    await settle();
    expect(reloaded.getState().you).toEqual({ kind: "screen", id: null, isHost: true });
  });

  it("oublie une session expirée", async () => {
    const { make } = setup();
    const storage = memoryStore();
    storage.set(
      "gamecore:session:ABCDEF",
      JSON.stringify({ code: "ABCDEF", kind: "player", token: "x".repeat(43) }),
    );
    const client = make(storage);
    expect(await client.resume("ABCDEF")).toBeNull();
    expect(client.stored("ABCDEF")).toBeNull();
    expect(await client.resume("ZZZZZZ")).toBeNull();
  });

  it("reprend automatiquement la session après une coupure réseau", async () => {
    const server = new GameServer({ game: rps, logger: silentLogger });
    const screen = new GameClient<Rps>({ transport: localTransport(server), storage: null });
    const { code } = await screen.create("screen");
    const net = flaky(server);
    const alice = new GameClient<Rps>({ transport: net.transport, storage: null });
    const { memberId } = await alice.join(code, { name: "Alice" });

    net.drop();
    await settle();
    expect(alice.getState().status).toBe("reconnecting");
    expect(screen.getState().room?.members[0]?.connected).toBe(false);

    net.restore();
    await settle();
    expect(alice.getState()).toMatchObject({ status: "connected", session: { memberId } });
    expect(screen.getState().room?.members[0]).toMatchObject({ id: memberId, connected: true });
  });

  it("met en file les requêtes envoyées avant l'ouverture de la connexion", async () => {
    const { make } = setup();
    const client = make();
    const pending = client.create("screen");
    expect(client.getState().status).toBe("connecting");
    await expect(pending).resolves.toMatchObject({ kind: "screen" });
  });

  it("gère l'expulsion : session terminée, jeton oublié, évènement « bye »", async () => {
    const { make } = setup();
    const screen = make();
    const { code } = await screen.create("screen");
    const storage = memoryStore();
    const bob = make(storage);
    const { memberId } = await bob.join(code, { name: "Bob" });
    const onBye = vi.fn();
    bob.on("bye", onBye);
    await screen.lobby.kick(memberId!);
    await settle();
    expect(onBye).toHaveBeenCalledWith("kicked");
    expect(bob.getState()).toMatchObject({ session: null, room: null, bye: "kicked" });
    expect(bob.stored(code)).toBeNull();
  });

  it("quitte le salon proprement", async () => {
    const { make } = setup();
    const screen = make();
    const { code } = await screen.create("screen");
    const alice = make();
    await alice.join(code, { name: "Alice" });
    await alice.leave();
    await settle();
    expect(alice.getState().session).toBeNull();
    expect(alice.stored(code)).toBeNull();
    expect(screen.getState().room?.members).toEqual([]);
  });

  it("transmet les entrées de manette à l'écran et les évènements du jeu", async () => {
    const { make } = setup();
    const screen = make();
    const { code } = await screen.create("screen");
    const alice = make();
    const { memberId } = await alice.join(code, { name: "Alice" });
    await make().join(code, { name: "Bob" });
    const inputs = vi.fn();
    const events = vi.fn();
    screen.on("input", inputs);
    screen.on("event", events);
    alice.sendInput({ button: "A" });
    await screen.lobby.start();
    await alice.act({ type: "choose", choice: "rock" });
    await settle();
    expect(inputs).toHaveBeenCalledWith(memberId, { button: "A" });
    expect(events).toHaveBeenCalledWith("chosen", { by: memberId });
  });

  it("ignore un état plus ancien que celui déjà reçu", () => {
    let handlers!: TransportHandlers;
    const client = new GameClient({
      transport: { connect: (h) => void (handlers = h), send: () => {}, close: () => {} },
      storage: null,
    });
    client.connect();
    handlers.open();
    const sync = (version: number, status: string) =>
      handlers.message(
        JSON.stringify({
          t: "sync",
          version,
          room: { code: "ABCDEF", status },
          you: { kind: "screen" },
          game: null,
        }),
      );
    sync(5, "playing");
    sync(4, "lobby");
    expect(client.getState()).toMatchObject({ version: 5, room: { status: "playing" } });
    handlers.message("ceci n'est pas du JSON");
    handlers.message(JSON.stringify({ pas: "de type" }));
    expect(client.getState().version).toBe(5);
  });

  it("échoue proprement si le serveur ne répond pas", async () => {
    vi.useFakeTimers();
    let handlers!: TransportHandlers;
    const client = new GameClient({
      transport: { connect: (h) => void (handlers = h), send: () => {}, close: () => {} },
      storage: null,
      requestTimeoutMs: 1000,
    });
    const pending = client.create("screen");
    handlers.open();
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("estime l'heure du serveur", async () => {
    const { make } = setup();
    const client = make();
    const rtt = await client.ping();
    expect(rtt).toBeGreaterThanOrEqual(0);
    expect(Math.abs(client.serverNow() - Date.now())).toBeLessThan(1000);
  });
});
