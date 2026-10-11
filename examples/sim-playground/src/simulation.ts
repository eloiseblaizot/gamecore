/**
 * « Renards et lapins » : un écosystème proies-prédateurs sur une grille torique.
 *
 * - Les lapins se déplacent, vieillissent et se reproduisent (plus au printemps qu'en hiver).
 * - Les renards chassent les lapins voisins ; ils perdent de l'énergie à chaque tick, en
 *   regagnent en mangeant, se reproduisent quand ils sont repus et meurent de faim.
 * - Les saisons tournent grâce à une commande système programmée (`ctx.schedule`) ; à chaque
 *   saison, une espèce éteinte revient par immigration (la démo ne s'arrête jamais).
 *
 * Tout l'état tient dans deux TypedArray modifiés en place : `cells` (contenu de chaque case)
 * et `energy` (âge d'un lapin, énergie d'un renard). C'est l'exemple de référence de
 * @gamecore/sim : voir docs/simulation.md.
 */

import { ByteReader, ByteWriter, defineSimulation, hashState, type SimTypes } from "@gamecore/sim";
import { z } from "zod";

/** Contenu d'une case. */
export const EMPTY = 0;
export const RABBIT = 1;
export const FOX = 2;

export const SEASONS = ["printemps", "été", "automne", "hiver"] as const;
/** Fécondité des lapins selon la saison. */
const SEASON_BREEDING = [1.5, 1.2, 0.8, 0.4];

const RABBIT_BREED = 0.08;
const RABBIT_MAX_AGE = 300;
const FOX_START_ENERGY = 30;
/** Chance qu'un renard attrape un lapin voisin. */
const FOX_HUNT = 0.3;
const FOX_MEAL = 12;
const FOX_MAX_ENERGY = 90;
const FOX_BREED_ENERGY = 50;
const FOX_BREED = 0.05;

/**
 * Indices des 8 voisins d'une case. Brouillon réutilisé à chaque animal (aucune allocation
 * dans la boucle) ; il ne fait pas partie de l'état : il est recalculé avant chaque usage.
 */
const NEIGHBORS = new Int32Array(8);

export interface EcoState {
  size: number;
  /** Contenu des cases (EMPTY, RABBIT, FOX), ligne par ligne. */
  cells: Uint8Array;
  /** Âge (lapin) ou énergie (renard) de l'occupant. */
  energy: Uint16Array;
  /** Indice dans SEASONS. */
  season: number;
  rabbits: number;
  foxes: number;
  /** Brouillon du tick : cases déjà jouées (remis à zéro à chaque tick, ni sauvegardé ni haché). */
  moved: Uint8Array;
}

export interface EcoStats {
  rabbits: number;
  foxes: number;
  season: number;
}

const settingsSchema = z.strictObject({
  size: z.number().int().min(16).max(512),
  /** Part initiale de lapins et de renards (0 à 1). */
  rabbitDensity: z.number().min(0).max(1),
  foxDensity: z.number().min(0).max(1),
  /** Durée d'une saison, en ticks. */
  seasonTicks: z.number().int().min(10).max(100_000),
});

const coord = z.number().int().min(0).max(511);
const count = z.number().int().min(1).max(1000);

/** Remplit NEIGHBORS avec les voisins de la case `i` (grille torique, sans modulo). */
function fillNeighbors(size: number, i: number): Int32Array {
  const x = i % size;
  const row = i - x;
  const last = size * size - size;
  const left = x === 0 ? size - 1 : x - 1;
  const right = x === size - 1 ? 0 : x + 1;
  const up = row === 0 ? last : row - size;
  const down = row === last ? 0 : row + size;
  NEIGHBORS[0] = up + left;
  NEIGHBORS[1] = up + x;
  NEIGHBORS[2] = up + right;
  NEIGHBORS[3] = row + left;
  NEIGHBORS[4] = row + right;
  NEIGHBORS[5] = down + left;
  NEIGHBORS[6] = down + x;
  NEIGHBORS[7] = down + right;
  return NEIGHBORS;
}

/** Une case voisine vide, en partant d'une direction tirée au hasard (`-1` s'il n'y en a pas). */
function emptyNeighbor(cells: Uint8Array, neighbors: Int32Array, r: number): number {
  const start = (r * 8) | 0;
  for (let k = 0; k < 8; k++) {
    const j = neighbors[(start + k) & 7]!;
    if (cells[j] === EMPTY) return j;
  }
  return -1;
}

/** Place jusqu'à `count` animaux autour de (x, y) : les lapins sur des cases vides, les renards aussi sur des lapins. */
function populate(
  state: EcoState,
  kind: number,
  x: number,
  y: number,
  count: number,
  next: () => number,
): number {
  const size = state.size;
  let placed = 0;
  for (let attempt = 0; attempt < count * 8 && placed < count; attempt++) {
    const radius = 2 + Math.floor(Math.sqrt(attempt));
    const px = (x + Math.floor((next() * 2 - 1) * radius) + size) % size;
    const py = (y + Math.floor((next() * 2 - 1) * radius) + size) % size;
    const index = py * size + px;
    const occupant = state.cells[index];
    if (occupant !== EMPTY && !(kind === FOX && occupant === RABBIT)) continue;
    state.cells[index] = kind;
    state.energy[index] = kind === FOX ? FOX_START_ENERGY : 0;
    placed++;
  }
  return placed;
}

function census(state: EcoState): void {
  let rabbits = 0;
  let foxes = 0;
  const cells = state.cells;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === RABBIT) rabbits++;
    else if (cells[i] === FOX) foxes++;
  }
  state.rabbits = rabbits;
  state.foxes = foxes;
}

export const foxesAndRabbits = defineSimulation({
  id: "foxes-and-rabbits",
  version: 1,
  ticksPerSecond: 10,
  settings: {
    schema: settingsSchema,
    defaults: { size: 128, rabbitDensity: 0.15, foxDensity: 0.005, seasonTicks: 150 },
  },

  /** Commandes de l'hôte : clic sur la grille. */
  commands: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("addRabbits"), x: coord, y: coord, count }),
    z.strictObject({ type: z.literal("addFoxes"), x: coord, y: coord, count }),
  ]),
  /** Commande système : changement de saison, programmée par la simulation elle-même. */
  systemCommands: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("season"), index: z.number().int().min(0).max(3) }),
  ]),

  create(ctx): EcoState {
    const { size, rabbitDensity, foxDensity, seasonTicks } = ctx.settings;
    const state: EcoState = {
      size,
      cells: new Uint8Array(size * size),
      energy: new Uint16Array(size * size),
      season: 0,
      rabbits: 0,
      foxes: 0,
      moved: new Uint8Array(size * size),
    };
    for (let i = 0; i < state.cells.length; i++) {
      const r = ctx.random.next();
      if (r < foxDensity) {
        state.cells[i] = FOX;
        state.energy[i] = FOX_START_ENERGY;
      } else if (r < foxDensity + rabbitDensity) {
        state.cells[i] = RABBIT;
        state.energy[i] = ctx.random.int(0, RABBIT_MAX_AGE / 2);
      }
    }
    census(state);
    ctx.schedule("season", seasonTicks, { type: "season", index: 1 });
    return state;
  },

  validate(state, command) {
    if (command.type === "season") return null;
    if (command.x >= state.size || command.y >= state.size) return "Case hors de la carte.";
    return null;
  },

  apply(state, command, ctx) {
    if (command.type === "season") {
      state.season = command.index;
      // Immigration : une population éteinte (ou presque) revient avec la nouvelle saison.
      census(state);
      const cells = state.cells.length;
      const next = () => ctx.random.next();
      const spot = () => Math.floor(next() * state.size);
      if (state.rabbits < cells * 0.01) {
        for (let k = 0; k < 4; k++) state.rabbits += populate(state, RABBIT, spot(), spot(), 150, next);
      }
      if (state.foxes < 8) state.foxes += populate(state, FOX, spot(), spot(), 12, next);
      ctx.schedule("season", ctx.settings.seasonTicks, { type: "season", index: (command.index + 1) % 4 });
      ctx.emit("season", { index: command.index, name: SEASONS[command.index] });
      ctx.invalidate("stats");
      return;
    }
    const kind = command.type === "addRabbits" ? RABBIT : FOX;
    const placed = populate(state, kind, command.x, command.y, command.count, () => ctx.random.next());
    if (kind === RABBIT) state.rabbits += placed;
    else state.foxes += placed;
    ctx.invalidate("stats");
  },

  systems: [
    {
      // Lapins puis renards, dans un ordre pseudo-aléatoire (permutation déterministe des cases)
      // pour ne favoriser aucune direction.
      name: "animals",
      update(state, ctx) {
        const { size, cells, energy, moved } = state;
        const n = cells.length;
        const random = ctx.random;
        const fertility = RABBIT_BREED * SEASON_BREEDING[state.season]!;
        moved.fill(0);
        const start = (random.next() * n) | 0;
        // n est une puissance de 2 pour les tailles usuelles ; un pas impair premier avec n
        // parcourt alors toutes les cases. Sinon, on revient au pas 1.
        const step = (n & (n - 1)) === 0 ? (random.next() * n) | 0 | 1 : 1;
        for (let k = 0, i = start; k < n; k++, i = i + step >= n ? i + step - n : i + step) {
          const kind = cells[i]!;
          if (kind === EMPTY || moved[i] === 1) continue;
          const neighbors = fillNeighbors(size, i);
          if (kind === RABBIT) {
            const age = energy[i]! + 1;
            if (age > RABBIT_MAX_AGE) {
              cells[i] = EMPTY;
              continue;
            }
            energy[i] = age;
            const target = emptyNeighbor(cells, neighbors, random.next());
            if (target < 0) continue;
            if (random.next() < fertility) {
              cells[target] = RABBIT;
              energy[target] = 0;
              moved[target] = 1;
            } else {
              cells[target] = RABBIT;
              energy[target] = age;
              cells[i] = EMPTY;
              moved[target] = 1;
            }
            continue;
          }
          // Renard : mange un lapin voisin s'il y en a un, sinon se déplace.
          const left = energy[i]! - 1;
          if (left <= 0) {
            cells[i] = EMPTY;
            continue;
          }
          let prey = -1;
          const first = (random.next() * 8) | 0;
          const hunts = random.next() < FOX_HUNT;
          for (let d = 0; d < 8 && prey < 0 && hunts; d++) {
            const j = neighbors[(first + d) & 7]!;
            if (cells[j] === RABBIT) prey = j;
          }
          const target = prey >= 0 ? prey : emptyNeighbor(cells, neighbors, random.next());
          if (target < 0) {
            energy[i] = left;
            continue;
          }
          const fed = prey >= 0 ? Math.min(FOX_MAX_ENERGY, left + FOX_MEAL) : left;
          cells[target] = FOX;
          moved[target] = 1;
          if (fed >= FOX_BREED_ENERGY && random.next() < FOX_BREED) {
            // Le petit reste sur place ; l'énergie est partagée.
            energy[target] = fed >> 1;
            energy[i] = fed >> 1;
            moved[i] = 1;
          } else {
            energy[target] = fed;
            cells[i] = EMPTY;
          }
        }
      },
    },
    {
      // Recensement, publié dans le canal « stats ».
      name: "census",
      every: 5,
      update(state, ctx) {
        census(state);
        ctx.invalidate("stats");
      },
    },
  ],

  snapshot: {
    full: (state, ctx) => ({ size: state.size, season: state.season, tick: ctx.tick }),
    channels: {
      /** La grille, à chaque tick : transférée telle quelle à la page (une copie dans le Worker). */
      grid: { every: 1, build: (state) => state.cells, transfer: true },
      stats: {
        build: (state): EcoStats => ({ rabbits: state.rabbits, foxes: state.foxes, season: state.season }),
      },
    },
  },

  codec: {
    encode(state) {
      return new ByteWriter(state.cells.length * 3 + 64)
        .u16(state.size)
        .u8(state.season)
        .u32(state.rabbits)
        .u32(state.foxes)
        .typed(state.cells)
        .typed(state.energy)
        .finish();
    },
    decode(bytes) {
      const r = new ByteReader(bytes);
      const size = r.u16();
      const season = r.u8();
      const rabbits = r.u32();
      const foxes = r.u32();
      const cells = r.uint8Array();
      const energy = r.uint16Array();
      if (
        size < 16 ||
        size > 512 ||
        cells.length !== size * size ||
        energy.length !== size * size ||
        season > 3
      ) {
        throw new RangeError("Grille incohérente.");
      }
      for (let i = 0; i < cells.length; i++) if (cells[i]! > FOX) throw new RangeError("Case inconnue.");
      return { size, season, rabbits, foxes, cells, energy, moved: new Uint8Array(size * size) };
    },
  },

  /** Le brouillon `moved` n'entre pas dans le hash (ni dans la sauvegarde). */
  hash: (state) =>
    hashState([state.size, state.season, state.rabbits, state.foxes, state.cells, state.energy]),
});

export type EcoCommand = SimTypes<typeof foxesAndRabbits>["command"];
