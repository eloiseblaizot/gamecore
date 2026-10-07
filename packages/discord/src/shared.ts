/**
 * Éléments communs au serveur et au navigateur : adresses de Discord, utilisateur Discord,
 * avatar, pseudo, et code de salon dérivé d'une instance de Discord Activity.
 */

import { ROOM_CODE_ALPHABET } from "@gamecore/core";

/** API REST de Discord (version figée : le format des réponses ne bouge pas sous nos pieds). */
export const DISCORD_API = "https://discord.com/api/v10";
/** Page d'autorisation OAuth2 de Discord. */
export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
/** Fournisseur d'identité inscrit sur les membres connectés avec Discord. */
export const DISCORD_PROVIDER = "discord";

/** Ce que renvoie Discord sur `/users/@me` (portée `identify`), réduit à ce qui nous sert. */
export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

/** Nom affiché : le nom global choisi par l'utilisateur, à défaut son nom d'utilisateur. */
export function discordDisplayName(user: DiscordUser): string {
  return user.global_name?.trim() || user.username;
}

/**
 * URL de l'avatar sur le CDN de Discord (hôte autorisé par la politique d'avatars par
 * défaut de gamecore). Sans avatar personnalisé : l'un des avatars par défaut de Discord.
 */
export function discordAvatarUrl(user: DiscordUser, size = 128): string {
  if (user.avatar && /^(a_)?[0-9a-f]{32}$/.test(user.avatar)) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`;
  }
  // Règle de Discord pour les comptes récents : (identifiant >> 22) mod 6.
  const index = /^\d{1,20}$/.test(user.id) ? Number((BigInt(user.id) >> 22n) % 6n) : 0;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Code de salon gamecore d'une instance de Discord Activity : toutes les personnes qui ont
 * lancé l'Activity dans le même salon vocal partagent l'instance, donc le même salon, sans
 * avoir à saisir de code. 12 symboles (60 bits) dérivés par SHA-256 de l'identifiant
 * d'instance, connu des seuls participants : impossible à deviner.
 */
export async function activityRoomCode(instanceId: string, length = 12): Promise<string> {
  if (instanceId.length === 0 || instanceId.length > 256)
    throw new RangeError("Identifiant d'instance invalide.");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`gamecore:${instanceId}`)),
  );
  return Array.from(digest.slice(0, length), (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join(
    "",
  );
}
