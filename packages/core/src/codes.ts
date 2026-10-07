/**
 * Codes de salon et jetons aléatoires.
 *
 * Les codes de salon sont tirés avec un générateur cryptographique : un code est le seul
 * « secret » qui protège une partie privée, il ne doit pas être devinable.
 */

/**
 * 32 symboles faciles à dicter et à taper sur un téléphone : pas de 0/O ni de 1/I.
 * 32 est une puissance de 2 : `octet % 32` n'introduit donc aucun biais statistique.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * 6 symboles = 32⁶ ≈ 1,07 milliard de combinaisons. Combiné à la limitation des essais
 * de connexion par adresse IP côté serveur, deviner le code d'une partie privée est irréaliste.
 */
export const ROOM_CODE_LENGTH = 6;

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{4,12}$`);

/** Nouveau code de salon aléatoire (ex. « K7QXPB »). */
export function generateRoomCode(length: number = ROOM_CODE_LENGTH): string {
  if (!Number.isInteger(length) || length < 4 || length > 12) {
    throw new RangeError("Un code de salon fait entre 4 et 12 caractères.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join("");
}

/**
 * Normalise une saisie utilisateur : majuscules, espaces et tirets retirés.
 * « k7q-xpb » → « K7QXPB ». Ne valide pas : voir {@link isRoomCode}.
 */
export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

/** Vrai si la chaîne (déjà normalisée) est un code de salon bien formé. */
export function isRoomCode(input: string): boolean {
  return ROOM_CODE_PATTERN.test(input);
}

/**
 * Jeton aléatoire en base64url (sans remplissage), 256 bits par défaut.
 * Sert aux jetons de session des joueurs et aux jetons d'administration des écrans.
 */
export function generateToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64Url(raw);
}

/** Empreinte SHA-256 (base64url) d'un jeton : le serveur ne stocke jamais le jeton en clair. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Comparaison à durée constante (pour comparer deux empreintes sans fuite temporelle).
 * Les deux chaînes sont comparées en entier même si elles diffèrent dès le début.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
