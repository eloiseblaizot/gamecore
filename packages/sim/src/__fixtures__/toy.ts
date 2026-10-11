/**
 * Simulation de test : une petite grille de compteurs. Elle exerce tout ce que le moteur doit
 * garantir : hasard dans `create` et dans un système, commandes refusées par `validate` (ou
 * dont la validation lève), commandes système programmées et annulées, systèmes `every`,
 * canaux (automatiques, invalidés, transférés), corruption dans `apply` ou dans un système.
 */

import { z } from "zod";
import { ByteReader, ByteWriter } from "../bytes.js";
import { defineSimulation } from "../definition.js";

export interface ToyState {
  size: number;
  cells: Uint16Array;
  total: number;
  painted: number;
  pulses: number;
  /** Tick auquel le système `crash` lèvera (0 : jamais). */
  crashAt: number;
}

const coord = z.number().int().min(-1000).max(1000);

export const toy = defineSimulation({
  id: "toy",
  version: 1,
  ticksPerSecond: 10,
  settings: {
    schema: z.strictObject({
      size: z.number().int().min(2).max(64),
      growth: z.number().int().min(0).max(10),
    }),
    defaults: { size: 8, growth: 1 },
  },
  commands: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("paint"),
      x: coord,
      y: coord,
      value: z.number().int().min(0).max(1000),
    }),
    z.strictObject({
      type: z.literal("pulseIn"),
      key: z.string().min(1).max(16),
      delay: z.number().int().min(1).max(100),
      amount: z.number().int().min(1).max(10),
    }),
    z.strictObject({ type: z.literal("cancelPulse"), key: z.string().min(1).max(16) }),
    z.strictObject({ type: z.literal("armCrash"), tick: z.number().int().min(1) }),
    z.strictObject({ type: z.literal("explode") }),
    z.strictObject({ type: z.literal("fragile") }),
  ]),
  systemCommands: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("pulse"), amount: z.number().int().min(1).max(10) }),
  ]),

  create(ctx): ToyState {
    const size = ctx.settings.size;
    const cells = new Uint16Array(size * size);
    for (let i = 0; i < 3; i++) cells[ctx.random.int(0, cells.length - 1)] = 1;
    ctx.emit("created", { size });
    return { size, cells, total: 3, painted: 0, pulses: 0, crashAt: 0 };
  },

  validate(state, command) {
    if (command.type === "paint") {
      if (command.x < 0 || command.y < 0 || command.x >= state.size || command.y >= state.size) {
        return "Case hors de la grille.";
      }
    }
    if (command.type === "fragile") throw new Error("validation en panne");
    return null;
  },

  apply(state, command, ctx) {
    switch (command.type) {
      case "paint":
        state.cells[command.y * state.size + command.x] = command.value;
        state.painted++;
        ctx.invalidate("stats");
        break;
      case "pulseIn":
        ctx.schedule(command.key, command.delay, { type: "pulse", amount: command.amount });
        break;
      case "cancelPulse":
        ctx.cancel(command.key);
        break;
      case "armCrash":
        state.crashAt = command.tick;
        break;
      case "explode":
        state.painted++;
        throw new Error("explosion après mutation");
      case "fragile":
        break;
      case "pulse":
        state.pulses += command.amount;
        ctx.emit("pulse", { amount: command.amount, origin: ctx.origin, tick: ctx.tick });
        break;
    }
  },

  systems: [
    {
      name: "grow",
      update(state, ctx) {
        for (let i = 0; i < ctx.settings.growth; i++)
          state.cells[ctx.random.int(0, state.cells.length - 1)]! += 1;
      },
    },
    {
      name: "census",
      every: 5,
      update(state, ctx) {
        let total = 0;
        for (let i = 0; i < state.cells.length; i++) total += state.cells[i]!;
        state.total = total;
        ctx.invalidate("stats");
      },
    },
    {
      name: "crash",
      update(state, ctx) {
        if (state.crashAt === ctx.tick) throw new Error("boum");
      },
    },
  ],

  snapshot: {
    full: (state, ctx) => ({ size: state.size, cells: state.cells, tick: ctx.tick }),
    channels: {
      grid: { every: 1, build: (state) => state.cells, transfer: true },
      stats: { build: (state) => ({ total: state.total, painted: state.painted, pulses: state.pulses }) },
      slow: { every: 3, build: (_state, ctx) => ctx.tick },
    },
  },

  codec: {
    encode(state) {
      return new ByteWriter()
        .u16(state.size)
        .typed(state.cells)
        .u32(state.total)
        .u32(state.painted)
        .u32(state.pulses)
        .u32(state.crashAt)
        .finish();
    },
    decode(bytes) {
      const r = new ByteReader(bytes);
      return {
        size: r.u16(),
        cells: r.uint16Array(),
        total: r.u32(),
        painted: r.u32(),
        pulses: r.u32(),
        crashAt: r.u32(),
      };
    },
  },
});
