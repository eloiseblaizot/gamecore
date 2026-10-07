/**
 * Faux Discord pour les tests de bout en bout : page d'autorisation OAuth2, échange du code
 * et `/users/@me`, avec les mêmes vérifications que Discord (identifiants de l'application,
 * code à usage unique, URL de retour identique, PKCE S256). Aucun accès à Internet.
 *
 * L'utilisateur « connecté » est choisi par le cookie `fake_discord_user` (défaut : lea).
 * Lancé par Playwright : `node e2e/fake-discord.ts` (Node exécute le TypeScript directement).
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.FAKE_DISCORD_PORT ?? 4174);
const CLIENT_ID = "fake-client";
const CLIENT_SECRET = "fake-secret";

const FAKE_USERS: Record<string, { id: string; username: string; global_name: string; avatar: null }> = {
  lea: { id: "100000000000000001", username: "lea", global_name: "Léa Discord", avatar: null },
  troll: { id: "100000000000000002", username: "troll", global_name: "Troll Discord", avatar: null },
};

interface Grant {
  user: string;
  redirectUri: string;
  challenge: string | null;
}

const codes = new Map<string, Grant>();
const tokens = new Map<string, string>();

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const base64Url = (buffer: Buffer) => buffer.toString("base64url");

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req as AsyncIterable<Buffer>) body += chunk.toString("utf8");
  return body;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Page d'autorisation : accorde immédiatement l'accès et renvoie vers l'application.
  if (req.method === "GET" && url.pathname === "/oauth2/authorize") {
    const p = url.searchParams;
    if (p.get("client_id") !== CLIENT_ID || p.get("response_type") !== "code")
      return json(res, 400, { error: "invalid_request" });
    const redirectUri = p.get("redirect_uri") ?? "";
    const user = /fake_discord_user=(\w+)/.exec(req.headers.cookie ?? "")?.[1] ?? "lea";
    if (p.get("code_challenge_method") && p.get("code_challenge_method") !== "S256") {
      return json(res, 400, { error: "invalid_request" });
    }
    const code = base64Url(randomBytes(16));
    codes.set(code, { user, redirectUri, challenge: p.get("code_challenge") });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state") ?? "");
    res.writeHead(302, { Location: back.toString() }).end();
    return;
  }

  // Échange du code contre un jeton d'accès.
  if (req.method === "POST" && url.pathname === "/api/v10/oauth2/token") {
    void readBody(req).then((raw) => {
      const form = new URLSearchParams(raw);
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
        return json(res, 401, { error: "invalid_client" });
      }
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? ""); // usage unique
      if (!grant) return json(res, 400, { error: "invalid_grant" });
      const redirectUri = form.get("redirect_uri");
      if (redirectUri !== null && redirectUri !== grant.redirectUri)
        return json(res, 400, { error: "invalid_grant" });
      if (grant.challenge) {
        const verifier = form.get("code_verifier") ?? "";
        if (base64Url(createHash("sha256").update(verifier).digest()) !== grant.challenge) {
          return json(res, 400, { error: "invalid_grant" });
        }
      }
      const token = `fake_${base64Url(randomBytes(24))}`;
      tokens.set(token, grant.user);
      json(res, 200, {
        access_token: token,
        token_type: "Bearer",
        expires_in: 604800,
        refresh_token: "ne-doit-jamais-sortir-du-serveur",
        scope: "identify",
      });
    });
    return;
  }

  // Utilisateur du jeton.
  if (req.method === "GET" && url.pathname === "/api/v10/users/@me") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const user = FAKE_USERS[tokens.get(token) ?? ""];
    return user ? json(res, 200, user) : json(res, 401, { message: "401: Unauthorized" });
  }

  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  json(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log(`Faux Discord sur http://localhost:${PORT}`));
