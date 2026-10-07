/**
 * Configuration publique servie par le serveur (`/api/config`) : un même build peut ainsi
 * être déployé avec ou sans Discord. Elle ne contient jamais de secret.
 *
 * Dans une Discord Activity, toute requête doit passer par le proxy de Discord (« /.proxy/ »).
 */

import { isDiscordActivity } from "@gamecore/discord/client";
import { use } from "react";

export interface PublicConfig {
  discord: { clientId: string; authorizeUrl?: string } | null;
}

/** Préfixe des requêtes vers notre serveur (« /.proxy » dans Discord). */
export const API_PREFIX = isDiscordActivity() ? "/.proxy" : "";

let config: Promise<PublicConfig> | null = null;

export function loadConfig(): Promise<PublicConfig> {
  config ??= fetch(`${API_PREFIX}/api/config`)
    .then((res) => (res.ok ? (res.json() as Promise<PublicConfig>) : { discord: null }))
    .catch(() => ({ discord: null }));
  return config;
}

/** Configuration publique (suspend le rendu jusqu'à son chargement : prévoir un <Suspense>). */
export function useConfig(): PublicConfig {
  return use(loadConfig());
}

/** Jeton Discord obtenu par la connexion web, en attente d'être présenté au serveur. */
const PENDING_CREDENTIAL = "buzzer:discord-credential";

export function savePendingCredential(token: string): void {
  sessionStorage.setItem(PENDING_CREDENTIAL, token);
}

/** Récupère (et efface : usage unique) le jeton Discord en attente. */
export function takePendingCredential(): string | null {
  const token = sessionStorage.getItem(PENDING_CREDENTIAL);
  sessionStorage.removeItem(PENDING_CREDENTIAL);
  return token;
}
