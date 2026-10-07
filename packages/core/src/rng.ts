/**
 * Générateur pseudo-aléatoire déterministe (algorithme SFC32).
 *
 * Pourquoi pas `Math.random()` ? Parce qu'un jeu doit pouvoir être rejoué à l'identique :
 * pour les tests (une graine fixe = une partie reproductible), pour déboguer une partie
 * signalée par un joueur, et pour reprendre un salon après un redémarrage du serveur.
 * L'état du générateur (4 entiers 32 bits) est donc sérialisable et sauvegardé avec le salon.
 *
 * ⚠️ Ce générateur n'est PAS cryptographique : il sert aux règles du jeu (mélanges, tirages),
 * jamais aux secrets (codes de salon, jetons), qui utilisent `crypto.getRandomValues`.
 */

export type RngState = readonly [number, number, number, number];

export interface Rng {
  /** Flottant dans [0, 1). */
  next(): number;
  /** Entier dans [min, max] (bornes incluses). */
  int(min: number, max: number): number;
  /** Vrai avec la probabilité `p` (entre 0 et 1). */
  chance(p: number): boolean;
  /** Un élément au hasard (erreur si la liste est vide). */
  pick<T>(items: readonly T[]): T;
  /** Copie mélangée de la liste (Fisher-Yates), l'originale n'est pas modifiée. */
  shuffle<T>(items: readonly T[]): T[];
  /** État courant, à sauvegarder pour reprendre la séquence plus tard. */
  state(): RngState;
}

/** Hachage 128 bits (cyrb128) : transforme une graine texte en état initial. */
export function seedFromString(seed: string): RngState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** Graine aléatoire (cryptographique) pour un nouveau salon. */
export function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createRng(seed: string | RngState): Rng {
  let [a, b, c, d] = typeof seed === "string" ? seedFromString(seed) : seed;

  const next = (): number => {
    // SFC32 : rapide, bonne qualité statistique, état de 128 bits.
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`Bornes invalides : [${min}, ${max}]`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new RangeError("Impossible de tirer dans une liste vide.");
      return items[int(0, items.length - 1)]!;
    },
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    state: () => [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
  };
}
