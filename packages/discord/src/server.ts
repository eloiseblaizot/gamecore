/**
 * Discord côté serveur.
 *
 * Deux briques :
 *   1. `createDiscordTokenHandler` : la route HTTP qui échange le code d'autorisation OAuth2
 *      contre un jeton d'accès. Elle seule connaît le secret de l'application Discord.
 *   2. `discordAuthenticator` : vérifie, pour `GameServer`, qu'un jeton d'accès présenté par
 *      un joueur est valide, en demandant à Discord à qui il appartient. Le joueur entre
 *      alors avec son identité Discord (pseudo, avatar, identifiant stable pour les bans).
 *
 *   const game = new GameServer({ game, authenticate: discordAuthenticator() });
 *   const tokenRoute = toNodeHandler(createDiscordTokenHandler({ clientId, clientSecret, redirectUri }));
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SlidingWindowCounter, type Authenticator, type VerifiedIdentity } from "@gamecore/server";
import { z } from "zod";
import {
  DISCORD_API,
  DISCORD_PROVIDER,
  discordAvatarUrl,
  discordDisplayName,
  type DiscordUser,
} from "./shared.js";

type Fetch = typeof globalThis.fetch;

export interface DiscordApiOptions {
  /** Base de l'API (à changer uniquement pour les tests, vers un faux Discord). */
  apiBase?: string;
  /** Implémentation de `fetch` (tests). */
  fetch?: Fetch;
  /** Délai max d'un appel à Discord (5 s par défaut). */
  timeoutMs?: number;
}

export interface DiscordAppOptions extends DiscordApiOptions {
  clientId: string;
  /** Secret de l'application : uniquement côté serveur, jamais dans le code du navigateur. */
  clientSecret: string;
  /** URL de retour de la connexion web (doit figurer dans le portail développeur Discord). */
  redirectUri?: string;
}

export interface DiscordToken {
  accessToken: string;
  expiresIn: number;
  scope: string;
}

/** Erreur d'un échange avec Discord : `status` est le code HTTP à renvoyer au navigateur. */
export class DiscordError extends Error {
  override readonly name = "DiscordError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(512),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  scope: z.string().max(1024),
});

const userSchema = z.object({
  id: z.string().regex(/^\d{1,20}$/),
  username: z.string().min(1).max(64),
  global_name: z.string().max(64).nullable().optional(),
  avatar: z.string().max(64).nullable().optional(),
});

async function call(options: DiscordApiOptions, path: string, init: RequestInit): Promise<Response> {
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    return await fetcher(`${options.apiBase ?? DISCORD_API}${path}`, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
  } catch {
    throw new DiscordError(502, "Discord ne répond pas, réessaie dans un instant.");
  }
}

/**
 * Échange un code d'autorisation contre un jeton d'accès.
 * `redirectUri` n'est envoyé que pour la connexion web (une Activity n'en a pas).
 */
export async function exchangeCode(
  options: DiscordAppOptions,
  code: string,
  extra: { codeVerifier?: string; redirectUri?: string } = {},
): Promise<DiscordToken> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: "authorization_code",
    code,
  });
  if (extra.redirectUri) body.set("redirect_uri", extra.redirectUri);
  if (extra.codeVerifier) body.set("code_verifier", extra.codeVerifier);
  const res = await call(options, "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (res.status >= 400 && res.status < 500) throw new DiscordError(401, "Code Discord invalide ou expiré.");
  if (!res.ok) throw new DiscordError(502, "Discord ne répond pas, réessaie dans un instant.");
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new DiscordError(502, "Réponse inattendue de Discord.");
  return {
    accessToken: parsed.data.access_token,
    expiresIn: parsed.data.expires_in,
    scope: parsed.data.scope,
  };
}

/** L'utilisateur à qui appartient ce jeton d'accès, ou `null` si le jeton est refusé. */
export async function fetchDiscordUser(
  accessToken: string,
  options: DiscordApiOptions = {},
): Promise<DiscordUser | null> {
  const res = await call(options, "/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new DiscordError(502, "Discord ne répond pas, réessaie dans un instant.");
  const parsed = userSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new DiscordError(502, "Réponse inattendue de Discord.");
  return parsed.data;
}

/** Identité gamecore d'un utilisateur Discord. */
export function discordIdentity(user: DiscordUser): VerifiedIdentity {
  return {
    provider: DISCORD_PROVIDER,
    externalId: user.id,
    name: discordDisplayName(user),
    avatar: discordAvatarUrl(user),
  };
}

/** Un jeton d'accès Discord a cette forme ; on ne dérange pas Discord pour autre chose. */
const ACCESS_TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;

export interface DiscordAuthenticatorOptions extends DiscordApiOptions {
  /** Durée de mémorisation d'une identité vérifiée (5 min par défaut), pour les reconnexions. */
  cacheMs?: number;
  /** Nombre max d'identités mémorisées (1000 par défaut). */
  cacheSize?: number;
  /** Horloge (tests). */
  now?: () => number;
}

/**
 * Authentificateur pour `GameServer` : la preuve d'identité est le jeton d'accès Discord du
 * joueur. Les identités vérifiées sont mémorisées brièvement (clé = empreinte du jeton,
 * jamais le jeton lui-même) pour ne pas solliciter Discord à chaque reconnexion.
 */
export function discordAuthenticator(options: DiscordAuthenticatorOptions = {}): Authenticator {
  const cacheMs = options.cacheMs ?? 5 * 60_000;
  const cacheSize = options.cacheSize ?? 1000;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { identity: VerifiedIdentity; expires: number }>();

  return async (credential) => {
    if (!ACCESS_TOKEN.test(credential)) return null;
    const key = await sha256(credential);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.identity;
    cache.delete(key);

    const user = await fetchDiscordUser(credential, options);
    if (!user) return null;
    const identity = discordIdentity(user);
    cache.set(key, { identity, expires: now() + cacheMs });
    // Map conserve l'ordre d'insertion : on évince les plus anciennes entrées.
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return identity;
  };
}

// --- Route d'échange du code ------------------------------------------------------

const tokenRequestSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  /** Vérificateur PKCE (RFC 7636 : 43 à 128 caractères non réservés). */
  codeVerifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/)
    .optional(),
  /** « web » : connexion depuis le site (avec URL de retour) ; « activity » : depuis Discord. */
  flow: z.enum(["web", "activity"]).default("activity"),
});

export interface DiscordTokenHandlerOptions extends DiscordAppOptions {
  /** Échanges autorisés par minute et par adresse IP (20 par défaut). */
  perMinute?: number;
  /** Taille max du corps de la requête (4 Kio par défaut). */
  maxBodyBytes?: number;
}

/**
 * Route `POST /api/discord/token` (API Fetch : Node, Cloudflare, Deno…). Corps JSON :
 * `{ code, codeVerifier?, flow? }`. Réponse : `{ accessToken, expiresIn, scope }` —
 * jamais le jeton de rafraîchissement, jamais le secret.
 */
export function createDiscordTokenHandler(options: DiscordTokenHandlerOptions) {
  const limiter = new SlidingWindowCounter(options.perMinute ?? 20, 60_000, () => Date.now());
  const maxBody = options.maxBodyBytes ?? 4096;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });

  return async (request: Request, context: { ip?: string | null } = {}): Promise<Response> => {
    if (request.method !== "POST") return json(405, { error: "Méthode non autorisée." });
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return json(415, { error: "Corps JSON attendu." });
    }
    const key = context.ip ?? "inconnue";
    if (limiter.isLimited(key)) return json(429, { error: "Trop de tentatives, réessaie dans une minute." });
    limiter.record(key);

    const text = await request.text();
    if (new TextEncoder().encode(text).length > maxBody)
      return json(413, { error: "Requête trop volumineuse." });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "Requête invalide." });
    }
    const parsed = tokenRequestSchema.safeParse(body);
    if (!parsed.success) return json(400, { error: "Requête invalide." });
    if (parsed.data.flow === "web" && !options.redirectUri) {
      return json(400, { error: "Connexion web non configurée." });
    }

    try {
      const token = await exchangeCode(options, parsed.data.code, {
        codeVerifier: parsed.data.codeVerifier,
        redirectUri: parsed.data.flow === "web" ? options.redirectUri : undefined,
      });
      return json(200, token);
    } catch (err) {
      if (err instanceof DiscordError) return json(err.status, { error: err.message });
      return json(500, { error: "Erreur inattendue du serveur." });
    }
  };
}

/**
 * Adapte une route de l'API Fetch au serveur HTTP de Node. Le corps est borné AVANT d'être
 * lu entièrement ; l'adresse IP est transmise pour la limitation de débit.
 */
export function toNodeHandler(
  handler: (request: Request, context: { ip?: string | null }) => Promise<Response>,
  options: { maxBodyBytes?: number; trustProxy?: boolean } = {},
) {
  const maxBody = options.maxBodyBytes ?? 4096;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBody) {
        res
          .writeHead(413, { "Content-Type": "application/json; charset=utf-8" })
          .end('{"error":"Requête trop volumineuse."}');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const method = req.method ?? "GET";
    const request = new Request(`http://localhost${req.url ?? "/"}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const forwarded = req.headers["x-forwarded-for"];
    const ip =
      options.trustProxy && typeof forwarded === "string"
        ? forwarded.split(",")[0]!.trim()
        : req.socket.remoteAddress;
    const response = await handler(request, { ip: ip ?? null });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
