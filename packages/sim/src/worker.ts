/**
 * @gamecore/sim/worker — héberge une simulation derrière un port (Web Worker, `localPort()`).
 *
 *   // sim.worker.ts
 *   import { exposeSimulation } from "@gamecore/sim/worker";
 *   import { foxesAndRabbits } from "./simulation";
 *   exposeSimulation(foxesAndRabbits, self);
 *
 * La simulation est créée à la demande de la page (`init` ou `load`), cadencée par un
 * `createRunner`, et publie ses canaux après chaque rafale de ticks. Les canaux marqués
 * `transfer` (TypedArray) sont recopiés UNE fois ici puis transférés sans autre copie : la
 * simulation garde son propre tampon, la page reçoit le sien.
 */

import { GameError, type ErrorCode } from "@gamecore/core";
import type { AnySimulation } from "./definition.js";
import {
  hostMessageSchema,
  type HostMessage,
  type PortHandler,
  type SimPort,
  type WorkerMessage,
} from "./protocol.js";
import { createRunner, type Runner, type RunnerOptions } from "./runner.js";
import {
  createSimulation,
  loadSimulation,
  type DrainPayload,
  type LoadOptions,
  type Sim,
  type SimOptions,
} from "./simulation.js";

export type { SimPort } from "./protocol.js";

export interface ExposeOptions {
  /** Options du cadenceur (sauf `onDrain`/`onLag`, branchés sur le port). */
  runner?: Omit<RunnerOptions, "onDrain" | "onLag" | "speed">;
  /** Options des simulations créées ou chargées (sauf graine et réglages, fournis par la page). */
  simulation?: Omit<SimOptions & LoadOptions, "seed" | "settings">;
}

export interface ExposedSimulation<D extends AnySimulation = AnySimulation> {
  /** Simulation en cours (`null` avant `init`/`load`). */
  readonly sim: Sim<D> | null;
  /** Arrête le cadenceur et ne répond plus aux messages. */
  close(): void;
}

type TypedArrayLike = ArrayBufferView & { slice(): ArrayBufferView };

const isTypedArray = (value: unknown): value is TypedArrayLike =>
  ArrayBuffer.isView(value) && !(value instanceof DataView);

/** Copie à transférer : la simulation garde son tampon, la page reçoit le sien. */
function transferable(data: unknown): { data: unknown; transfer: ArrayBuffer[] } {
  if (isTypedArray(data)) {
    const copy = data.slice();
    return { data: copy, transfer: copy.buffer instanceof ArrayBuffer ? [copy.buffer] : [] };
  }
  if (data instanceof ArrayBuffer) {
    const copy = data.slice(0);
    return { data: copy, transfer: [copy] };
  }
  return { data, transfer: [] };
}

function errorOf(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof GameError) return { code: err.code, message: err.message };
  if (err instanceof RangeError || err instanceof TypeError)
    return { code: "BAD_REQUEST", message: err.message };
  return { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

/** Répond au protocole de @gamecore/sim sur `port`. */
export function exposeSimulation<D extends AnySimulation>(
  definition: D,
  port: SimPort,
  options: ExposeOptions = {},
): ExposedSimulation<D> {
  let sim: Sim<D> | null = null;
  let runner: Runner<D> | null = null;
  let transfers = new Set<string>();
  let subscribed: Set<string> | null = null;
  let closed = false;

  const post = (message: WorkerMessage, transfer: ArrayBuffer[] = []) => {
    if (closed) return;
    port.postMessage(message, transfer.length > 0 ? { transfer } : undefined);
  };
  const fail = (id: number | null, err: unknown) => post({ t: "error", id, ...errorOf(err) });

  const publish = (payload: DrainPayload) => {
    const tick = payload.tick;
    for (const [name, value] of Object.entries(payload.channels)) {
      if (subscribed && !subscribed.has(name)) continue;
      if (transfers.has(name)) {
        const { data, transfer } = transferable(value);
        post({ t: "channel", name, data, tick }, transfer);
      } else {
        post({ t: "channel", name, data: value, tick });
      }
    }
    const stats = runner?.stats();
    post({
      t: "events",
      tick,
      events: payload.events,
      dropped: payload.droppedEvents,
      tps: stats?.actualTicksPerSecond ?? 0,
      lagging: stats?.lagging ?? false,
    });
    const corrupted = sim?.corrupted;
    if (corrupted && payload.events.some((e) => e.name === "corrupted"))
      post({ t: "corrupted", ...corrupted });
  };

  const start = (id: number, next: Sim<D>, speed: number | undefined, paused: boolean | undefined) => {
    // Construit d'abord le snapshot : s'il lève, la simulation en cours n'est pas remplacée.
    const snapshot = next.snapshot();
    runner?.stop();
    sim = next;
    transfers = new Set(
      Object.entries(definition.snapshot.channels ?? {})
        .filter(([, channel]) => (channel as { transfer?: boolean }).transfer === true)
        .map(([name]) => name),
    );
    subscribed = null;
    runner = createRunner(next, {
      ...options.runner,
      speed: speed ?? 1,
      onDrain: publish,
      onLag: (ticksBehind) => post({ t: "lag", tick: next.tick, ticksBehind }),
    });
    post({
      t: "ready",
      id,
      tick: next.tick,
      seed: next.seed,
      settings: next.settings,
      ticksPerSecond: runner.ticksPerSecond,
      speed: runner.speed,
      paused: paused === true,
      channels: Object.keys(definition.snapshot.channels ?? {}),
    });
    post({ t: "snapshot", id: null, ...snapshot });
    // Événements de `create` (ou rien après un chargement) : publiés tout de suite.
    publish(next.drain());
    if (paused !== true) runner.start();
  };

  const requireSim = (): Sim<D> => {
    if (!sim || !runner)
      throw new GameError("BAD_REQUEST", "Simulation non démarrée : envoyez d'abord init ou load.");
    return sim;
  };

  const handle = (message: HostMessage) => {
    switch (message.t) {
      case "init": {
        const next = createSimulation(definition, {
          ...options.simulation,
          seed: message.seed,
          settings: message.settings as Partial<unknown>,
        });
        start(message.id, next, message.speed, message.paused);
        return;
      }
      case "load":
        start(
          message.id,
          loadSimulation(definition, message.bytes, options.simulation),
          message.speed,
          message.paused,
        );
        return;
      case "dispatch": {
        const result = requireSim().dispatch(message.command);
        if (result.ok) post({ t: "ack", id: message.id, data: result.seq });
        else fail(message.id, result.error);
        return;
      }
      case "control": {
        requireSim();
        const control = message.control;
        if (control.op === "speed") runner!.setSpeed(control.speed);
        else if (control.op === "pause") runner!.pause();
        else if (control.op === "resume") runner!.start();
        else runner!.step(control.ticks);
        post({ t: "ack", id: message.id });
        return;
      }
      case "subscribe": {
        requireSim();
        subscribed = message.channels ? new Set(message.channels) : null;
        post({ t: "ack", id: message.id });
        return;
      }
      case "snapshot":
        post({ t: "snapshot", id: message.id, ...requireSim().snapshot() });
        return;
      case "hash":
        post({ t: "ack", id: message.id, data: requireSim().hash() });
        return;
      case "save": {
        const bytes = requireSim().save();
        post({ t: "saved", id: message.id, bytes }, [bytes.buffer]);
        return;
      }
    }
  };

  const onmessage: PortHandler = (event) => {
    if (closed) return;
    const parsed = hostMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      const raw = event.data as { id?: unknown } | null;
      const id = typeof raw?.id === "number" && Number.isSafeInteger(raw.id) && raw.id >= 0 ? raw.id : null;
      fail(id, new GameError("BAD_REQUEST", "Message invalide."));
      return;
    }
    try {
      handle(parsed.data);
    } catch (err) {
      fail(parsed.data.id, err);
    }
  };
  port.onmessage = onmessage;

  return {
    get sim() {
      return sim;
    },
    close() {
      closed = true;
      runner?.stop();
      port.onmessage = null;
    },
  };
}
