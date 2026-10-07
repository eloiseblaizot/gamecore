/// <reference types="node" />
// Test d'intégration : vrai serveur Socket.io sur un port local.
import { GameServer, silentLogger } from "@gamecore/server";
import { attachSocketIo, secureSocketIoOptions } from "@gamecore/server/socket-io";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import { rps } from "../../server/src/__fixtures__/rps.js";
import { GameClient } from "./client.js";
import { socketIoTransport } from "./socket-io.js";
import { memoryStore } from "./storage.js";

let http: HttpServer;
let io: Server;
const clients: GameClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await io?.close();
  await new Promise((r) => http?.close(r));
});

async function start() {
  http = createServer();
  io = new Server(http, secureSocketIoOptions({ allowedOrigins: "*" }));
  attachSocketIo(io, new GameServer({ game: rps, logger: silentLogger }));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function client(url: string) {
  const c = new GameClient<typeof rps>({
    transport: socketIoTransport(url, { transports: ["websocket"], reconnectionDelay: 50 }),
    storage: memoryStore(),
  });
  clients.push(c as GameClient);
  return c;
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe("transport Socket.io côté client", () => {
  it("joue une partie à travers le réseau", async () => {
    const url = await start();
    const screen = client(url);
    const { code } = await screen.create("screen");
    const alice = client(url);
    const bob = client(url);
    await alice.join(code, { name: "Alice" });
    await bob.join(code, { name: "Bob" });
    await screen.lobby.start();
    await alice.act({ type: "choose", choice: "rock" });
    await until(() => alice.getState().game?.private?.myChoice === "rock");
    expect(screen.getState().room?.members).toHaveLength(2);
    expect(await alice.ping()).toBeGreaterThanOrEqual(0);
  });

  it("se reconnecte et reprend la session après une coupure côté serveur", async () => {
    const url = await start();
    const screen = client(url);
    const { code } = await screen.create("screen");
    const alice = client(url);
    const { memberId } = await alice.join(code, { name: "Alice" });

    // Coupure brutale de toutes les connexions par le serveur.
    io.disconnectSockets(true);
    await until(() => alice.getState().status === "connected" && screen.getState().status === "connected");
    await until(() => screen.getState().room?.members[0]?.connected === true);
    expect(screen.getState().room?.members[0]?.id).toBe(memberId);
    expect(screen.getState().you?.isHost).toBe(true);
  });
});
