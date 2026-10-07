import { describe, expect, it, vi } from "vitest";
import {
  DiscordError,
  createDiscordTokenHandler,
  discordAuthenticator,
  exchangeCode,
  fetchDiscordUser,
} from "./server.js";

const app = {
  clientId: "123",
  clientSecret: "secret-de-test",
  redirectUri: "https://jeu.example/auth/discord",
};
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz";
const USER = { id: "80351110224678912", username: "lea_42", global_name: "Léa", avatar: null };

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeDiscord(overrides: Partial<Record<"token" | "me", () => Response>> = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/oauth2/token")) {
      return (
        overrides.token?.() ??
        reply(200, {
          access_token: TOKEN,
          token_type: "Bearer",
          expires_in: 604800,
          refresh_token: "rafraichissement-secret",
          scope: "identify",
        })
      );
    }
    if (url.endsWith("/users/@me")) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${TOKEN}`) return reply(401, { message: "401: Unauthorized" });
      return overrides.me?.() ?? reply(200, USER);
    }
    return reply(404, {});
  });
}

describe("exchangeCode", () => {
  it("envoie le code, le secret et le vérificateur PKCE à Discord", async () => {
    const fetch = fakeDiscord();
    const token = await exchangeCode({ ...app, fetch }, "le-code", {
      codeVerifier: "v".repeat(43),
      redirectUri: app.redirectUri,
    });
    expect(token).toEqual({ accessToken: TOKEN, expiresIn: 604800, scope: "identify" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://discord.com/api/v10/oauth2/token");
    const body = new URLSearchParams(init!.body as URLSearchParams);
    expect(Object.fromEntries(body)).toEqual({
      client_id: "123",
      client_secret: "secret-de-test",
      grant_type: "authorization_code",
      code: "le-code",
      redirect_uri: app.redirectUri,
      code_verifier: "v".repeat(43),
    });
  });

  it("traduit les erreurs de Discord", async () => {
    await expect(
      exchangeCode({ ...app, fetch: fakeDiscord({ token: () => reply(400, {}) }) }, "x"),
    ).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      exchangeCode({ ...app, fetch: fakeDiscord({ token: () => reply(503, {}) }) }, "x"),
    ).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      exchangeCode({ ...app, fetch: fakeDiscord({ token: () => reply(200, { nope: 1 }) }) }, "x"),
    ).rejects.toBeInstanceOf(DiscordError);
    const offline = vi.fn(async () => {
      throw new TypeError("réseau coupé");
    });
    await expect(exchangeCode({ ...app, fetch: offline }, "x")).rejects.toMatchObject({ status: 502 });
  });
});

describe("fetchDiscordUser", () => {
  it("renvoie l'utilisateur, ou null pour un jeton refusé", async () => {
    const fetch = fakeDiscord();
    expect(await fetchDiscordUser(TOKEN, { fetch })).toEqual(USER);
    expect(await fetchDiscordUser("autre-jeton-invalide", { fetch })).toBeNull();
  });

  it("refuse une réponse mal formée", async () => {
    const fetch = fakeDiscord({ me: () => reply(200, { id: "pas-un-nombre", username: "x" }) });
    await expect(fetchDiscordUser(TOKEN, { fetch })).rejects.toBeInstanceOf(DiscordError);
  });
});

describe("discordAuthenticator", () => {
  it("transforme un jeton valide en identité Discord vérifiée", async () => {
    const authenticate = discordAuthenticator({ fetch: fakeDiscord() });
    expect(await authenticate(TOKEN, { ip: null, origin: null, userAgent: null })).toEqual({
      provider: "discord",
      externalId: USER.id,
      name: "Léa",
      avatar: expect.stringMatching(/^https:\/\/cdn\.discordapp\.com\//),
    });
  });

  it("ne sollicite pas Discord pour un jeton mal formé, ni deux fois pour le même jeton", async () => {
    let now = 0;
    const fetch = fakeDiscord();
    const authenticate = discordAuthenticator({ fetch, cacheMs: 1000, now: () => now });
    const meta = { ip: null, origin: null, userAgent: null };
    expect(await authenticate("court", meta)).toBeNull();
    expect(await authenticate("avec des espaces et des accents é".padEnd(20, "x"), meta)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await authenticate(TOKEN, meta);
    await authenticate(TOKEN, meta);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 1001;
    await authenticate(TOKEN, meta);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuse un jeton révoqué", async () => {
    const authenticate = discordAuthenticator({ fetch: fakeDiscord() });
    expect(
      await authenticate("jeton-revoque-0123456789", { ip: null, origin: null, userAgent: null }),
    ).toBeNull();
  });
});

describe("route d'échange du code", () => {
  const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    new Request("https://jeu.example/api/discord/token", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("renvoie le jeton d'accès, jamais le jeton de rafraîchissement ni le secret", async () => {
    const handler = createDiscordTokenHandler({ ...app, fetch: fakeDiscord() });
    const res = await handler(post({ code: "abc", codeVerifier: "v".repeat(43), flow: "web" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ accessToken: TOKEN, expiresIn: 604800, scope: "identify" });
    expect(text).not.toContain("rafraichissement");
    expect(text).not.toContain("secret-de-test");
  });

  it("n'envoie l'URL de retour que pour la connexion web", async () => {
    const fetch = fakeDiscord();
    const handler = createDiscordTokenHandler({ ...app, fetch });
    await handler(post({ code: "abc" }));
    const body = new URLSearchParams(fetch.mock.calls[0]![1]!.body as URLSearchParams);
    expect(body.has("redirect_uri")).toBe(false);
  });

  it("valide strictement la requête", async () => {
    const handler = createDiscordTokenHandler({ ...app, fetch: fakeDiscord() });
    expect((await handler(new Request("https://jeu.example/api/discord/token"))).status).toBe(405);
    expect((await handler(post({ code: "abc" }, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect((await handler(post("{pas du json"))).status).toBe(400);
    expect((await handler(post({ code: "abc", redirectUri: "https://evil.example" }))).status).toBe(400);
    expect((await handler(post({ code: "a b" }))).status).toBe(400);
    expect((await handler(post({ code: "abc", codeVerifier: "court" }))).status).toBe(400);
    expect((await handler(post({ code: "x".repeat(5000) }))).status).toBe(413);
    const noWeb = createDiscordTokenHandler({ clientId: "1", clientSecret: "s", fetch: fakeDiscord() });
    expect((await noWeb(post({ code: "abc", flow: "web" }))).status).toBe(400);
  });

  it("répercute un code refusé par Discord", async () => {
    const handler = createDiscordTokenHandler({
      ...app,
      fetch: fakeDiscord({ token: () => reply(400, {}) }),
    });
    const res = await handler(post({ code: "perime" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Code Discord invalide ou expiré." });
  });

  it("limite les échanges par adresse IP", async () => {
    const handler = createDiscordTokenHandler({ ...app, fetch: fakeDiscord(), perMinute: 2 });
    for (let i = 0; i < 2; i++)
      expect((await handler(post({ code: "abc" }), { ip: "203.0.113.9" })).status).toBe(200);
    expect((await handler(post({ code: "abc" }), { ip: "203.0.113.9" })).status).toBe(429);
    expect((await handler(post({ code: "abc" }), { ip: "198.51.100.4" })).status).toBe(200);
  });
});
