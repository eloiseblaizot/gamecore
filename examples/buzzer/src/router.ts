/**
 * Routeur minimal (trois pages) : pas besoin d'une bibliothèque pour si peu.
 *   /              accueil
 *   /screen/CODE   écran de l'hôte (télé, PC partagé)
 *   /play/CODE     manette (téléphone d'un joueur)
 *   /auth/discord  retour de la connexion Discord
 */

import { isRoomCode, normalizeRoomCode } from "@gamecore/core";
import { useMemo, useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "screen"; code: string }
  | { name: "play"; code: string }
  | { name: "discord-callback" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/auth/discord") return { name: "discord-callback" };
  const match = /^\/(screen|play)\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    const code = normalizeRoomCode(decodeURIComponent(match[2]!));
    if (isRoomCode(code)) return { name: match[1] as "screen" | "play", code };
  }
  return { name: "home" };
}

const subscribe = (callback: () => void) => {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
};

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname);
  return useMemo(() => parseRoute(pathname), [pathname]);
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
