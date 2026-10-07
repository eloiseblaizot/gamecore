import { PROTOCOL_VERSION, type ServerMessage } from "@gamecore/core";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { rps } from "./__fixtures__/rps.js";
import { silentLogger } from "./logger.js";
import { GameServer } from "./server.js";
import { SOCKET_IO_EVENT, attachSocketIo, secureSocketIoOptions } from "./socket-io.js";

const ORIGIN = "https://jeu.example";
let http: HttpServer;
let io: Server;
const sockets: Socket[] = [];

async function start(allowedOrigins: readonly string[] | "*" = [ORIGIN]) {
  http = createServer();
  io = new Server(http, secureSocketIoOptions({ allowedOrigins }));
  const game = new GameServer({ game: rps, logger: silentLogger });
  attachSocketIo(io, game);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, game };
}

function open(url: string, origin = ORIGIN) {
  const socket = connect(url, { transports: ["websocket"], extraHeaders: { origin }, reconnection: false });
  sockets.push(socket);
  const received: ServerMessage[] = [];
  socket.on(SOCKET_IO_EVENT, (data: string) => received.push(JSON.parse(data) as ServerMessage));
  let id = 0;
  const request = async (message: Record<string, unknown>) => {
    const ref = ++id;
    socket.emit(SOCKET_IO_EVENT, JSON.stringify({ ...message, id: ref }));
    for (let i = 0; i < 100; i++) {
      const reply = received.find((m) => (m.t === "ack" || m.t === "error") && m.ref === ref);
      if (reply) return reply;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("pas de réponse");
  };
  return { socket, received, request };
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await io?.close();
  await new Promise((r) => http?.close(r));
});

describe("transport Socket.io", () => {
  it("fait jouer un écran et des joueurs à travers le réseau", async () => {
    const { url } = await start();
    const screen = open(url);
    const created = await screen.request({ t: "create", v: PROTOCOL_VERSION, as: "screen" });
    expect(created).toMatchObject({ t: "ack", data: { kind: "screen" } });
    const code = (created as { data: { code: string } }).data.code;

    const alice = open(url);
    const bob = open(url);
    await alice.request({ t: "join", v: PROTOCOL_VERSION, code, profile: { name: "Alice" } });
    await bob.request({ t: "join", v: PROTOCOL_VERSION, code, profile: { name: "Bob" } });
    expect(await screen.request({ t: "lobby", op: { op: "start" } })).toMatchObject({ t: "ack" });
    await alice.request({ t: "action", action: { type: "choose", choice: "rock" } });

    const lastSync = (c: { received: ServerMessage[] }) => c.received.filter((m) => m.t === "sync").at(-1);
    expect(lastSync(alice)).toMatchObject({ game: { private: { myChoice: "rock" } } });
    expect(JSON.stringify(bob.received)).not.toContain("rock");
  });

  it("refuse les connexions venant d'une origine non autorisée", async () => {
    const { url, game } = await start();
    const intruder = open(url, "https://site-malveillant.example");
    const error = await new Promise<Error>((resolve) => intruder.socket.on("connect_error", resolve));
    expect(error.message).toMatch(/websocket error|Origine/i);
    expect(game.stats().connections).toBe(0);
  });

  it("libère la place du joueur à la déconnexion", async () => {
    const { url, game } = await start("*");
    const screen = open(url);
    await screen.request({ t: "create", v: PROTOCOL_VERSION, as: "screen" });
    expect(game.stats()).toEqual({ rooms: 1, connections: 1 });
    screen.socket.disconnect();
    for (let i = 0; i < 50 && game.stats().connections > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(game.stats().connections).toBe(0);
  });
});
