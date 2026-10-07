/**
 * Discord côté navigateur : connexion web (OAuth2 + PKCE) et Discord Activity.
 *
 * Connexion web (le jeu tourne sur son propre site) :
 *   1. `startDiscordLogin()` génère un `state` et un couple PKCE, les garde dans
 *      `sessionStorage`, puis envoie le joueur sur la page d'autorisation de Discord ;
 *   2. Discord le renvoie sur l'URL de retour avec un `code` ;
 *   3. `completeDiscordLogin()` vérifie le `state` (anti-CSRF), échange le code via la route
 *      serveur (seule à connaître le secret) et renvoie le jeton d'accès, que le client
 *      présente ensuite comme preuve d'identité : `client.join(code, profil, { credential })`.
 *
 * Discord Activity (le jeu tourne DANS Discord, dans un salon vocal) :
 *   `startDiscordActivity()` fait tout d'un coup et renvoie, en plus du jeton, le code du
 *   salon gamecore dérivé de l'instance : tout le salon vocal joue ensemble, sans code.
 */

import { activityRoomCode, DISCORD_AUTHORIZE_URL, type DiscordUser } from "./shared.js";

// --- PKCE ---------------------------------------------------------------------------

/** Couple PKCE (RFC 7636, méthode S256) : le vérificateur reste dans le navigateur. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier) };
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Connexion web --------------------------------------------------------------------

/** Clé de `sessionStorage` de la connexion en cours. */
const PENDING_KEY = "gamecore:discord:pending";

interface PendingLogin {
  state: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
}

/** Une connexion non terminée au bout de 10 minutes est abandonnée. */
const PENDING_TTL_MS = 10 * 60_000;

export interface DiscordLoginOptions {
  clientId: string;
  /** URL de retour, déclarée dans le portail développeur Discord (ex. https://monjeu.fr/auth/discord). */
  redirectUri: string;
  /** Portées demandées (`identify` par défaut : identifiant, pseudo, avatar). */
  scope?: string[];
  /** Où revenir après la connexion (chemin relatif du site, ex. « /play/K7QXPB »). */
  returnTo?: string;
  /** Page d'autorisation (à changer uniquement pour les tests). */
  authorizeUrl?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Navigation (tests) ; par défaut `location.assign`. */
  navigate?: (url: string) => void;
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string[];
  authorizeUrl?: string;
}): string {
  const url = new URL(options.authorizeUrl ?? DISCORD_AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", (options.scope ?? ["identify"]).join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "none");
  return url.toString();
}

/** Lance la connexion : redirige vers Discord. */
export async function startDiscordLogin(options: DiscordLoginOptions): Promise<void> {
  const storage = options.storage ?? globalThis.sessionStorage;
  const { verifier, challenge } = await createPkce();
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const pending: PendingLogin = {
    state,
    verifier,
    returnTo: safeReturnPath(options.returnTo ?? "/"),
    createdAt: Date.now(),
  };
  storage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = buildAuthorizeUrl({ ...options, state, challenge });
  (options.navigate ?? ((u) => globalThis.location.assign(u)))(url);
}

export interface DiscordLoginResult {
  accessToken: string;
  expiresIn: number;
  /** Chemin où revenir (toujours un chemin du site : pas de redirection ouverte). */
  returnTo: string;
}

/** Erreur de connexion Discord, avec un message affichable. */
export class DiscordLoginError extends Error {
  override readonly name = "DiscordLoginError";
}

/**
 * Termine la connexion sur la page de retour. Vérifie le `state`, échange le code via la
 * route serveur, puis efface le code de l'URL (historique, en-tête Referer).
 */
export async function completeDiscordLogin(options: {
  /** Route serveur d'échange du code, ex. « /api/discord/token ». */
  tokenEndpoint: string;
  url?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  fetch?: typeof globalThis.fetch;
}): Promise<DiscordLoginResult> {
  const storage = options.storage ?? globalThis.sessionStorage;
  const url = new URL(options.url ?? globalThis.location.href);
  const raw = storage.getItem(PENDING_KEY);
  storage.removeItem(PENDING_KEY); // usage unique, quoi qu'il arrive
  if (!options.url) globalThis.history?.replaceState(null, "", url.pathname);

  if (url.searchParams.get("error") === "access_denied") {
    throw new DiscordLoginError("Connexion Discord annulée.");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  let pending: PendingLogin | null;
  try {
    pending = raw ? (JSON.parse(raw) as PendingLogin) : null;
  } catch {
    pending = null;
  }
  if (!pending || !code || !state || state !== pending.state) {
    throw new DiscordLoginError("Connexion Discord invalide : recommence depuis le jeu.");
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    throw new DiscordLoginError("Connexion Discord expirée : recommence depuis le jeu.");
  }

  const token = await requestToken(
    options.tokenEndpoint,
    { code, codeVerifier: pending.verifier, flow: "web" },
    options.fetch,
  );
  return { ...token, returnTo: safeReturnPath(pending.returnTo) };
}

/** N'accepte qu'un chemin du site (« /play/ABC »), jamais une autre origine (« //evil.com »). */
export function safeReturnPath(path: string): string {
  return /^\/(?![/\\])[^\s]*$/.test(path) ? path : "/";
}

async function requestToken(
  endpoint: string,
  body: { code: string; codeVerifier?: string; flow: "web" | "activity" },
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ accessToken: string; expiresIn: number }> {
  let res: Response;
  try {
    res = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new DiscordLoginError("Serveur injoignable, vérifie ta connexion.");
  }
  const data = (await res.json().catch(() => null)) as {
    accessToken?: unknown;
    expiresIn?: unknown;
    error?: unknown;
  } | null;
  if (!res.ok || typeof data?.accessToken !== "string") {
    throw new DiscordLoginError(
      typeof data?.error === "string" ? data.error : "Connexion Discord impossible.",
    );
  }
  return {
    accessToken: data.accessToken,
    expiresIn: typeof data.expiresIn === "number" ? data.expiresIn : 0,
  };
}

// --- Discord Activity -------------------------------------------------------------------

/** Ce dont on a besoin du SDK Discord (sous-ensemble de `DiscordSDK`, remplaçable en test). */
export interface DiscordSdkLike {
  readonly instanceId: string;
  ready(): Promise<void>;
  readonly commands: {
    authorize(args: {
      client_id: string;
      response_type: "code";
      state: string;
      prompt: "none";
      scope: ("identify" | "guilds")[];
      code_challenge?: string;
      code_challenge_method?: "S256";
    }): Promise<{ code: string }>;
    authenticate(args: { access_token: string }): Promise<{ user: DiscordUser }>;
  };
}

export interface DiscordActivitySession {
  sdk: DiscordSdkLike;
  accessToken: string;
  user: DiscordUser;
  instanceId: string;
  /** Code du salon gamecore de cette instance, à rejoindre avec `create: true`. */
  roomCode: string;
}

/**
 * Le jeu est-il lancé dans une Discord Activity ? Discord ajoute `frame_id` et
 * `instance_id` à l'URL de l'iframe.
 */
export function isDiscordActivity(search: string = globalThis.location?.search ?? ""): boolean {
  const params = new URLSearchParams(search);
  return params.has("frame_id") && params.has("instance_id");
}

/**
 * Initialise une Discord Activity : SDK prêt, autorisation (PKCE), échange du code via la
 * route serveur (dans une Activity, toute requête passe par le proxy « /.proxy/ » de
 * Discord), authentification du SDK, et code du salon de l'instance.
 */
export async function startDiscordActivity(options: {
  clientId: string;
  tokenEndpoint?: string;
  scope?: ("identify" | "guilds")[];
  /** Fabrique du SDK (tests) ; par défaut le vrai SDK, chargé à la demande. */
  createSdk?: (clientId: string) => Promise<DiscordSdkLike>;
  fetch?: typeof globalThis.fetch;
}): Promise<DiscordActivitySession> {
  const createSdk =
    options.createSdk ??
    (async (clientId: string) => {
      // Chargé à la demande : le SDK n'alourdit pas le jeu hors de Discord.
      const { DiscordSDK } = await import("@discord/embedded-app-sdk");
      return new DiscordSDK(clientId);
    });
  const sdk = await createSdk(options.clientId);
  await sdk.ready();
  const { verifier, challenge } = await createPkce();
  const { code } = await sdk.commands.authorize({
    client_id: options.clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: options.scope ?? ["identify"],
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const token = await requestToken(
    options.tokenEndpoint ?? "/.proxy/api/discord/token",
    { code, codeVerifier: verifier, flow: "activity" },
    options.fetch,
  );
  const { user } = await sdk.commands.authenticate({ access_token: token.accessToken });
  return {
    sdk,
    accessToken: token.accessToken,
    user,
    instanceId: sdk.instanceId,
    roomCode: await activityRoomCode(sdk.instanceId),
  };
}
