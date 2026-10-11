import { createTestServer, type TestClient } from "@gamecore/server/testing";
import { decodeJwt, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rps } from "../../server/src/__fixtures__/rps.js";
import { livekitModule, livekitRoomName, type LiveKitAccess, type LiveKitModuleOptions } from "./server.js";

const KEYS = {
  url: "wss://video.example",
  apiKey: "cle-de-test",
  apiSecret: "secret-de-test-assez-long-pour-hs256",
};

interface VideoGrant {
  room: string;
  roomJoin: boolean;
  canPublish: boolean;
  canPublishSources?: string[];
  canSubscribe: boolean;
  canPublishData: boolean;
  canUpdateOwnMetadata: boolean;
  hidden?: boolean;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup(options: Partial<LiveKitModuleOptions> = {}) {
  const test = createTestServer({ game: rps, modules: [livekitModule({ ...KEYS, ...options })] });
  const screen: TestClient = test.client();
  const { code } = await screen.create("screen");
  const alice: TestClient = test.client();
  await alice.join(code, "Alice");
  return { ...test, screen, alice, code };
}

const ask = (c: TestClient) =>
  c.request<LiveKitAccess | null>({ t: "module", name: "livekit", data: { op: "token" } });

async function grantOf(access: LiveKitAccess | null) {
  expect(access).not.toBeNull();
  // Signature vérifiée avec le secret : le jeton vient bien du serveur.
  await jwtVerify(access!.token, new TextEncoder().encode(KEYS.apiSecret));
  return decodeJwt(access!.token) as {
    sub: string;
    name: string;
    video: VideoGrant;
    exp: number;
    nbf: number;
  };
}

describe("module LiveKit", () => {
  it("délivre à un joueur un jeton signé pour publier caméra et micro", async () => {
    const { alice, server, code } = await setup();
    const access = await ask(alice);
    expect(access).toMatchObject({
      url: KEYS.url,
      identity: alice.sync().you.id,
      publish: { camera: true, microphone: true },
    });
    const claims = await grantOf(access);
    expect(claims.sub).toBe(alice.sync().you.id);
    expect(claims.name).toBe("Alice");
    expect(claims.video).toMatchObject({
      room: livekitRoomName(server.getRoom(code)!.id),
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(claims.video.canPublishSources).toEqual(["camera", "microphone"]);
    expect(claims.video.hidden).toBeFalsy();
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(2 * 60 * 60);
  });

  it("nomme la salle d'après l'identifiant aléatoire du salon, jamais d'après son code", async () => {
    const { alice, code } = await setup();
    const { video } = await grantOf(await ask(alice));
    expect(video.room).not.toContain(code);
    expect(video.room).toMatch(/^gc-[A-Za-z0-9_-]{16}$/);
  });

  it("laisse les spectateurs regarder sans publier", async () => {
    const { client, code } = await setup();
    const curious: TestClient = client();
    await curious.join(code, "Curieux", { spectator: true });
    const access = await ask(curious);
    expect(access?.publish).toEqual({ camera: false, microphone: false });
    const { video } = await grantOf(access);
    expect(video.canPublish).toBe(false);
    expect(video.canPublishSources ?? []).toEqual([]);
  });

  it("rend l'écran partagé invisible dans la salle", async () => {
    const { screen } = await setup();
    const access = await ask(screen);
    expect(access?.identity).toMatch(/^screen-[0-9a-f]{16}$/);
    const { video, name } = await grantOf(access);
    expect(video).toMatchObject({ hidden: true, canPublish: false, canSubscribe: true });
    expect(name).toBe("Écran");
  });

  it("applique la politique du jeu (ex. caméras coupées par l'host)", async () => {
    const policy = vi.fn(({ settings }: { settings: unknown }) =>
      (settings as { rounds: number }).rounds > 3 ? { publish: { camera: true, microphone: false } } : null,
    );
    const { alice, screen } = await setup({ policy });
    expect(await ask(alice)).toBeNull();
    await screen.lobby({ op: "settings", settings: { rounds: 5 } });
    expect((await ask(alice))?.publish).toEqual({ camera: true, microphone: false });
    expect(policy).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "lobby", member: expect.objectContaining({ name: "Alice" }) }),
    );
  });

  it("refuse les demandes mal formées, hors salon ou trop fréquentes", async () => {
    const { alice, client } = await setup({ tokensPerMinute: 2 });
    expect(await alice.expectError({ t: "module", name: "livekit", data: { op: "admin" } })).toBe(
      "BAD_REQUEST",
    );
    expect(await client().expectError({ t: "module", name: "livekit", data: { op: "token" } })).toBe(
      "BAD_REQUEST",
    );
    await ask(alice);
    await ask(alice);
    expect(await alice.expectError({ t: "module", name: "livekit", data: { op: "token" } })).toBe(
      "RATE_LIMITED",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(ask(alice)).resolves.not.toBeNull();
  });

  it("refuse une configuration incomplète", () => {
    expect(() => livekitModule({ ...KEYS, url: "https://pas-une-websocket" })).toThrow(/wss/);
    expect(() => livekitModule({ ...KEYS, apiSecret: "" })).toThrow(/secret/);
  });

  it("répond MODULE_DISABLED à un module inconnu", async () => {
    const { alice } = await setup();
    expect(await alice.expectError({ t: "module", name: "inconnu", data: {} })).toBe("MODULE_DISABLED");
  });
});
