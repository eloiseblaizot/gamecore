// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  completeDiscordLogin,
  isDiscordActivity,
  pkceChallenge,
  safeReturnPath,
  startDiscordActivity,
  startDiscordLogin,
  type DiscordSdkLike,
} from "./client.js";
import { activityRoomCode } from "./shared.js";

const okToken = () =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ accessToken: "tok_1234567890abcdef", expiresIn: 3600 }), { status: 200 }),
  );

describe("PKCE", () => {
  it("respecte le vecteur de test de la RFC 7636", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("connexion web", () => {
  it("construit l'URL d'autorisation avec state et PKCE", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "123",
        redirectUri: "https://jeu.example/auth/discord",
        state: "etat",
        challenge: "defi",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "123",
      response_type: "code",
      redirect_uri: "https://jeu.example/auth/discord",
      scope: "identify",
      state: "etat",
      code_challenge: "defi",
      code_challenge_method: "S256",
    });
  });

  it("fait l'aller-retour complet : redirection, vérification du state, échange du code", async () => {
    let target = "";
    await startDiscordLogin({
      clientId: "123",
      redirectUri: "https://jeu.example/auth/discord",
      returnTo: "/play/K7QXPB",
      navigate: (u) => (target = u),
    });
    const authorize = new URL(target);
    const state = authorize.searchParams.get("state")!;
    const challenge = authorize.searchParams.get("code_challenge")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const fetch = okToken();
    const result = await completeDiscordLogin({
      tokenEndpoint: "/api/discord/token",
      url: `https://jeu.example/auth/discord?code=le-code&state=${state}`,
      fetch,
    });
    expect(result).toEqual({
      accessToken: "tok_1234567890abcdef",
      expiresIn: 3600,
      returnTo: "/play/K7QXPB",
    });
    const sent = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      code: string;
      codeVerifier: string;
      flow: string;
    };
    expect(sent.code).toBe("le-code");
    expect(sent.flow).toBe("web");
    // Le vérificateur envoyé au serveur correspond bien au défi envoyé à Discord.
    expect(await pkceChallenge(sent.codeVerifier)).toBe(challenge);
    // Usage unique : la même réponse ne peut pas être rejouée.
    await expect(
      completeDiscordLogin({
        tokenEndpoint: "/t",
        url: `https://jeu.example/auth/discord?code=x&state=${state}`,
        fetch,
      }),
    ).rejects.toThrow(/invalide/);
  });

  it("refuse un state différent (attaque CSRF) ou une connexion annulée", async () => {
    await startDiscordLogin({
      clientId: "1",
      redirectUri: "https://jeu.example/cb",
      navigate: () => undefined,
    });
    await expect(
      completeDiscordLogin({
        tokenEndpoint: "/t",
        url: "https://jeu.example/cb?code=x&state=forge",
        fetch: okToken(),
      }),
    ).rejects.toThrow(/invalide/);
    await startDiscordLogin({
      clientId: "1",
      redirectUri: "https://jeu.example/cb",
      navigate: () => undefined,
    });
    await expect(
      completeDiscordLogin({
        tokenEndpoint: "/t",
        url: "https://jeu.example/cb?error=access_denied",
        fetch: okToken(),
      }),
    ).rejects.toThrow(/annulée/);
  });

  it("refuse une connexion trop ancienne", async () => {
    vi.useFakeTimers();
    let target = "";
    await startDiscordLogin({
      clientId: "1",
      redirectUri: "https://jeu.example/cb",
      navigate: (u) => (target = u),
    });
    vi.advanceTimersByTime(11 * 60_000);
    const state = new URL(target).searchParams.get("state");
    await expect(
      completeDiscordLogin({
        tokenEndpoint: "/t",
        url: `https://jeu.example/cb?code=x&state=${state}`,
        fetch: okToken(),
      }),
    ).rejects.toThrow(/expirée/);
    vi.useRealTimers();
  });

  it("relaie le message d'erreur du serveur", async () => {
    let target = "";
    await startDiscordLogin({
      clientId: "1",
      redirectUri: "https://jeu.example/cb",
      navigate: (u) => (target = u),
    });
    const state = new URL(target).searchParams.get("state");
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Code Discord invalide ou expiré." }), { status: 401 }),
    );
    await expect(
      completeDiscordLogin({
        tokenEndpoint: "/t",
        url: `https://jeu.example/cb?code=x&state=${state}`,
        fetch,
      }),
    ).rejects.toThrow("Code Discord invalide ou expiré.");
  });

  it("n'autorise que des chemins du site comme destination (pas de redirection ouverte)", () => {
    expect(safeReturnPath("/play/K7QXPB")).toBe("/play/K7QXPB");
    for (const evil of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      // eslint-disable-next-line no-script-url -- c'est précisément ce qu'on veut refuser
      "javascript:alert(1)",
      "/a b",
    ]) {
      expect(safeReturnPath(evil)).toBe("/");
    }
  });
});

describe("Discord Activity", () => {
  it("détecte le lancement dans Discord", () => {
    expect(isDiscordActivity("?instance_id=i-1&frame_id=f-1&platform=desktop")).toBe(true);
    expect(isDiscordActivity("?code=K7QXPB")).toBe(false);
  });

  it("autorise, échange le code, s'authentifie et dérive le code du salon", async () => {
    const authorize = vi.fn(async () => ({ code: "code-activity" }));
    const authenticate = vi.fn(async () => ({ user: { id: "42", username: "lea", global_name: "Léa" } }));
    const sdk: DiscordSdkLike = {
      instanceId: "i-123-gc-456-789",
      ready: vi.fn(async () => undefined),
      commands: { authorize, authenticate },
    };
    const fetch = okToken();
    const session = await startDiscordActivity({ clientId: "123", createSdk: async () => sdk, fetch });

    expect(session).toMatchObject({
      accessToken: "tok_1234567890abcdef",
      user: { id: "42" },
      instanceId: "i-123-gc-456-789",
      roomCode: await activityRoomCode("i-123-gc-456-789"),
    });
    expect(sdk.ready).toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: "123", scope: ["identify"], code_challenge_method: "S256" }),
    );
    expect(authenticate).toHaveBeenCalledWith({ access_token: "tok_1234567890abcdef" });
    const [endpoint, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe("/.proxy/api/discord/token");
    expect(JSON.parse(init.body as string)).toMatchObject({ code: "code-activity", flow: "activity" });
  });
});
