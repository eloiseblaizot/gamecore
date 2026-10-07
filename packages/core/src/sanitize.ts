/**
 * Nettoyage des textes saisis par les joueurs (pseudos, messages, avatars).
 *
 * Ces textes sont affichés sur l'écran de tout le monde, souvent en stream : on retire
 * tout ce qui pourrait tromper l'affichage (caractères invisibles, inversion du sens
 * d'écriture, retours à la ligne) et on borne leur longueur. L'échappement HTML, lui,
 * reste du ressort de l'interface (React échappe déjà tout par défaut).
 */

export const DISPLAY_NAME_MAX_LENGTH = 24;
export const CHAT_MAX_LENGTH = 280;

/**
 * Caractères de contrôle et séparateurs de ligne : remplacés par une espace.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028-\u2029]/g;

/**
 * Caractères invisibles, supprimés : espaces de largeur nulle, marques et surcharges
 * bidirectionnelles (U+202A–U+202E, U+2066–U+2069 : la faille « Trojan Source »),
 * caractères de remplacement d'objet. Les liants U+200C/U+200D sont conservés : ils
 * servent aux emojis composés (👨‍👩‍👧) et à certaines écritures (persan, hindi…).
 */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B\u200E-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Tronque au nombre de « caractères perçus » (graphèmes) : un emoji famille compte pour 1. */
export function truncateGraphemes(input: string, max: number): string {
  let out = "";
  let count = 0;
  for (const { segment } of segmenter.segment(input)) {
    if (count >= max) break;
    out += segment;
    count++;
  }
  return out;
}

/** Nombre de graphèmes (caractères perçus) d'une chaîne. */
export function graphemeLength(input: string): number {
  let count = 0;
  for (const _ of segmenter.segment(input)) count++;
  return count;
}

/** Texte sur une ligne : normalisé (NFKC), sans caractères invisibles, espaces fusionnés. */
export function sanitizeLine(input: unknown, max: number): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input
    .normalize("NFKC")
    .replace(CONTROL, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = truncateGraphemes(cleaned, max).trim();
  return truncated.length > 0 ? truncated : null;
}

/** Pseudo affichable, ou `null` s'il est vide une fois nettoyé. */
export function sanitizeDisplayName(input: unknown, max: number = DISPLAY_NAME_MAX_LENGTH): string | null {
  return sanitizeLine(input, max);
}

/**
 * Rend un pseudo unique dans le salon : « Léa », « Léa 2 », « Léa 3 »…
 * La comparaison ignore la casse et les accents, pour éviter « Lea » / « Léa ».
 */
export function uniqueName(
  name: string,
  taken: Iterable<string>,
  max: number = DISPLAY_NAME_MAX_LENGTH,
): string {
  const fold = (s: string) =>
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase();
  const used = new Set(Array.from(taken, fold));
  if (!used.has(fold(name))) return name;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const candidate = truncateGraphemes(name, max - suffix.length) + suffix;
    if (!used.has(fold(candidate))) return candidate;
  }
}

export interface AvatarPolicy {
  /** Hôtes autorisés pour les avatars en image (HTTPS uniquement). */
  hosts: readonly string[];
  /** Longueur max d'un avatar « emoji » (en graphèmes). */
  maxEmojiLength: number;
}

/** Par défaut : emojis, ou image hébergée par Discord. */
export const DEFAULT_AVATAR_POLICY: AvatarPolicy = {
  hosts: ["cdn.discordapp.com", "media.discordapp.net"],
  maxEmojiLength: 2,
};

/**
 * Valide un avatar : soit une URL HTTPS vers un hôte autorisé (pas de `javascript:`,
 * pas de `data:`, pas de pistage via une image hébergée n'importe où), soit un emoji court.
 * Renvoie l'avatar nettoyé, ou `null` s'il est refusé.
 */
export function sanitizeAvatar(input: unknown, policy: AvatarPolicy = DEFAULT_AVATAR_POLICY): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 512) return null;
  if (input.startsWith("https://")) {
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      return policy.hosts.includes(url.hostname) ? url.toString() : null;
    } catch {
      return null;
    }
  }
  const emoji = sanitizeLine(input, policy.maxEmojiLength);
  // Un avatar « texte » doit être un pictogramme, pas un mot : on refuse lettres et chiffres.
  if (!emoji || /[\p{L}\p{N}]/u.test(emoji)) return null;
  return emoji;
}
