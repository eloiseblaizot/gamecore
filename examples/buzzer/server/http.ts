/**
 * Service des fichiers statiques de l'application, avec des en-têtes de sécurité.
 *
 * Volontairement minimal (aucune dépendance) : en production, on peut aussi servir `dist/`
 * depuis un CDN et ne garder ici que le serveur de jeu.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * Politique de sécurité du contenu : uniquement nos propres scripts, styles et connexions
 * (les WebSockets de même origine sont couverts par 'self'), images locales ou Discord.
 * Par défaut, `frame-ancestors 'none'` interdit d'intégrer le jeu dans une iframe
 * (anti-clickjacking) ; une Discord Activity a besoin de l'autoriser pour Discord seulement.
 */
export function contentSecurityPolicy(frameAncestors: readonly string[] = ["'none'"]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https://cdn.discordapp.com",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors.join(" ")}`,
  ].join("; ");
}

/** Origines de Discord autorisées à afficher le jeu dans une Activity. */
export const DISCORD_FRAME_ANCESTORS = [
  "https://discord.com",
  "https://*.discord.com",
  "https://*.discordsays.com",
] as const;

export function securityHeaders(frameAncestors?: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(frameAncestors),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Le quiz n'a besoin ni de caméra, ni de micro, ni de localisation.
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  // Anciens navigateurs : X-Frame-Options, seulement quand aucune intégration n'est permise.
  if (!frameAncestors) headers["X-Frame-Options"] = "DENY";
  return headers;
}

/** Crée un gestionnaire HTTP qui sert `root` (application monopage : repli sur index.html). */
export function staticHandler(
  root: string,
  options: { hsts?: boolean; frameAncestors?: readonly string[] } = {},
) {
  const base = resolve(root);
  const headers = securityHeaders(options.frameAncestors);
  if (options.hsts) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // Anti-traversée de répertoire : le chemin résolu doit rester DANS `root`.
    const target = resolve(join(base, normalize(pathname)));
    if (target !== base && !target.startsWith(base + sep)) {
      res.writeHead(403).end();
      return;
    }

    const file = (await isFile(target)) ? target : join(base, "index.html");
    const type = MIME[extname(file)] ?? "application/octet-stream";
    // Les fichiers « hachés » de Vite (assets/) ne changent jamais : cache long.
    const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
