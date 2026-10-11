/**
 * Protocole entre une page (hôte) et une simulation hébergée ailleurs : un Web Worker, ou le
 * transport en mémoire `localPort()` (tests, page sans Worker). Les deux côtés valident
 * chaque message reçu avec zod, même si l'autre côté est censé être le nôtre.
 *
 * Page → simulation : `init`, `load`, `dispatch`, `control`, `subscribe`, `snapshot`,
 * `hash`, `save`. Chaque requête porte un `id`, renvoyé dans la réponse (`ready`, `ack`,
 * `snapshot`, `saved`) ou dans l'`error`.
 *
 * Simulation → page : les réponses, et des messages spontanés : `snapshot` (après `ready`),
 * `channel` (un par canal publié), `events` (après chaque rafale de ticks, même vide : il
 * porte le tick courant et la cadence réelle), `lag`, `corrupted`.
 */

import { ERROR_CODES } from "@gamecore/core";
import { z } from "zod";

/**
 * Port structurel : un `Worker`, le `self` d'un Worker, un `MessagePort`, ou `localPort()`.
 * Typé sans la bibliothèque `WebWorker` (qui entre en conflit avec `DOM` dans tsc) :
 * `onmessage` reçoit simplement un gestionnaire `(event: { data }) => void`.
 */
export interface SimPort {
  postMessage(message: unknown, options?: { transfer?: ArrayBuffer[] }): void;
  onmessage: unknown;
}

/** Gestionnaire installé dans `port.onmessage`. */
export type PortHandler = (event: { data: unknown }) => void;

const id = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tick = z.number().int().min(0);
const name = z.string().min(1).max(64);
const speed = z.number().min(0).max(64);
const bytes = z.instanceof(Uint8Array);

export const hostMessageSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("init"),
    id,
    seed: z.string().min(1).max(256).optional(),
    settings: z.unknown().optional(),
    speed: speed.optional(),
    paused: z.boolean().optional(),
  }),
  z.strictObject({
    t: z.literal("load"),
    id,
    bytes,
    speed: speed.optional(),
    paused: z.boolean().optional(),
  }),
  z.strictObject({ t: z.literal("dispatch"), id, command: z.unknown() }),
  z.strictObject({
    t: z.literal("control"),
    id,
    control: z.discriminatedUnion("op", [
      z.strictObject({ op: z.literal("speed"), speed }),
      z.strictObject({ op: z.literal("pause") }),
      z.strictObject({ op: z.literal("resume") }),
      z.strictObject({ op: z.literal("step"), ticks: z.number().int().min(1).max(100_000) }),
    ]),
  }),
  /** `channels: null` : tous les canaux (par défaut). */
  z.strictObject({ t: z.literal("subscribe"), id, channels: z.array(name).max(64).nullable() }),
  z.strictObject({ t: z.literal("snapshot"), id }),
  z.strictObject({ t: z.literal("hash"), id }),
  z.strictObject({ t: z.literal("save"), id }),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
export type SimControl = Extract<HostMessage, { t: "control" }>["control"];

const event = z.strictObject({ name: z.string().max(64), data: z.unknown(), tick });

export const workerMessageSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("ready"),
    id,
    tick,
    seed: z.string().nullable(),
    settings: z.unknown(),
    ticksPerSecond: z.number().positive(),
    speed,
    paused: z.boolean(),
    channels: z.array(name),
  }),
  z.strictObject({ t: z.literal("ack"), id, data: z.unknown().optional() }),
  z.strictObject({
    t: z.literal("error"),
    id: id.nullable(),
    code: z.enum(ERROR_CODES),
    message: z.string().max(2000),
  }),
  z.strictObject({
    t: z.literal("snapshot"),
    id: id.nullable(),
    tick,
    full: z.unknown(),
    channels: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ t: z.literal("channel"), name, data: z.unknown(), tick }),
  z.strictObject({
    t: z.literal("events"),
    tick,
    events: z.array(event),
    dropped: z.number().int().min(0),
    /** Cadence réelle mesurée par le cadenceur (ticks/s). */
    tps: z.number().min(0),
    lagging: z.boolean(),
  }),
  z.strictObject({ t: z.literal("lag"), tick, ticksBehind: z.number().int().min(1) }),
  z.strictObject({ t: z.literal("saved"), id, bytes }),
  z.strictObject({ t: z.literal("corrupted"), tick, system: z.string(), cause: z.string() }),
]);

export type WorkerMessage = z.infer<typeof workerMessageSchema>;
export type ReadyMessage = Extract<WorkerMessage, { t: "ready" }>;
