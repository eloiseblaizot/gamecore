/**
 * @gamecore/sim/worker-client — pilote, depuis la page, une simulation hébergée par
 * `exposeSimulation` (dans un Web Worker, ou derrière `localPort()`).
 *
 *   const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
 *   const remote = connectSimulation<typeof foxesAndRabbits>(worker);
 *   remote.on("channel:grid", (cells) => draw(cells));
 *   await remote.init({ seed: "abc" });
 *   await remote.dispatch({ type: "addRabbits", x: 3, y: 4, count: 10 });
 *
 * Même contrat que `Sim`, mais asynchrone : chaque requête est corrélée par un `id` et
 * rejetée avec un `GameError` (code `TIMEOUT` si la simulation ne répond pas).
 */

import { GameError } from "@gamecore/core";
import type { AnySimulation, ChannelName, SimTypes } from "./definition.js";
import { Emitter } from "./emitter.js";
import {
  workerMessageSchema,
  type HostMessage,
  type PortHandler,
  type ReadyMessage,
  type SimControl,
  type SimPort,
  type WorkerMessage,
} from "./protocol.js";
import type { CommandRejection, CorruptionInfo, SimEvent, SimSnapshot } from "./simulation.js";

export type { SimPort } from "./protocol.js";

/** Informations renvoyées par `init` et `load`. */
export type RemoteSimInfo = Omit<ReadyMessage, "t" | "id">;

/** Battement envoyé après chaque rafale de ticks. */
export interface RemoteTick {
  tick: number;
  /** Cadence réelle (ticks/s). */
  tps: number;
  lagging: boolean;
  /** Événements perdus faute de place dans le tampon de la simulation. */
  dropped: number;
}

export type RemoteSimEvents<D extends AnySimulation> = {
  ready: [RemoteSimInfo];
  snapshot: [SimSnapshot<SimTypes<D>["full"]>];
  tick: [RemoteTick];
  /** Tous les événements émis par la simulation (`ctx.emit`), dans l'ordre. */
  events: [SimEvent[]];
  commandRejected: [CommandRejection];
  lag: [number];
  corrupted: [CorruptionInfo];
  /** Erreur sans requête associée (message invalide, par exemple). */
  error: [GameError];
} & { [K in `channel:${ChannelName<D>}`]: [unknown, number] } & {
  [K in `event:${string}`]: [unknown, number];
};

export interface RemoteSim<D extends AnySimulation = AnySimulation> {
  /** Dernier tick connu. */
  readonly tick: number;
  /** Informations du dernier `init`/`load` (`null` avant). */
  readonly info: RemoteSimInfo | null;
  /** Démarre une nouvelle simulation (`paused` : sans lancer le cadenceur). */
  init(options?: {
    seed?: string;
    settings?: Partial<SimTypes<D>["settings"]>;
    speed?: number;
    paused?: boolean;
  }): Promise<RemoteSimInfo>;
  /** Charge une sauvegarde. Les octets sont TRANSFÉRÉS : le tableau passé devient inutilisable. */
  load(bytes: Uint8Array, options?: { speed?: number; paused?: boolean }): Promise<RemoteSimInfo>;
  /** Met une commande en file ; renvoie son numéro (`seq`). */
  dispatch(command: SimTypes<D>["command"]): Promise<number>;
  setSpeed(speed: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Exécute `ticks` ticks tout de suite (même en pause). */
  step(ticks?: number): Promise<void>;
  /** Canaux à recevoir (`null` : tous, par défaut). */
  subscribe(channels: ChannelName<D>[] | null): Promise<void>;
  snapshot(): Promise<SimSnapshot<SimTypes<D>["full"]>>;
  hash(): Promise<string>;
  /** Sauvegarde binaire (transférée depuis le Worker, sans copie). */
  save(): Promise<Uint8Array>;
  /** Dernière donnée reçue d'un canal (`undefined` si aucune). */
  latest(channel: ChannelName<D>): unknown;
  on<K extends keyof RemoteSimEvents<D>>(
    event: K,
    listener: (...args: Extract<RemoteSimEvents<D>[K], unknown[]>) => void,
  ): () => void;
  /** Rejette les requêtes en attente et cesse d'écouter le port (ne termine pas le Worker). */
  close(): void;
}

export interface ConnectOptions {
  /** Délai de réponse d'une requête (10 s par défaut). */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve(message: WorkerMessage): void;
  reject(error: GameError): void;
  timer: ReturnType<typeof setTimeout>;
}

type Request = HostMessage extends infer M ? (M extends { id: number } ? Omit<M, "id"> : never) : never;

/** Se connecte à une simulation exposée sur `port`. */
export function connectSimulation<D extends AnySimulation = AnySimulation>(
  port: SimPort,
  options: ConnectOptions = {},
): RemoteSim<D> {
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  // Émetteur non typé en interne : les clés `channel:*` et `event:*` sont dynamiques.
  const emitter = new Emitter<Record<string, unknown[]>>();
  const pending = new Map<number, Pending>();
  const latest = new Map<string, unknown>();
  let nextId = 1;
  let tick = 0;
  let info: RemoteSimInfo | null = null;
  let closed = false;

  const request = (message: Request, transfer: ArrayBuffer[] = []): Promise<WorkerMessage> => {
    if (closed) return Promise.reject(new GameError("DISCONNECTED", "Connexion à la simulation fermée."));
    const id = nextId++;
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new GameError("TIMEOUT", "La simulation ne répond pas."));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ ...message, id }, transfer.length > 0 ? { transfer } : undefined);
    });
  };

  const settle = (id: number, outcome: WorkerMessage | GameError) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (outcome instanceof GameError) entry.reject(outcome);
    else entry.resolve(outcome);
  };

  const onEvents = (events: SimEvent[]) => {
    if (events.length === 0) return;
    emitter.emit("events", events);
    for (const e of events) {
      if (e.name === "commandRejected") emitter.emit("commandRejected", e.data);
      emitter.emit(`event:${e.name}`, e.data, e.tick);
    }
  };

  const onmessage: PortHandler = (event) => {
    if (closed) return;
    const parsed = workerMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      emitter.emit("error", new GameError("BAD_REQUEST", "Message invalide reçu de la simulation."));
      return;
    }
    const message = parsed.data;
    switch (message.t) {
      case "ready": {
        const { t: _t, id, ...rest } = message;
        info = rest;
        tick = rest.tick;
        latest.clear();
        settle(id, message);
        emitter.emit("ready", rest);
        return;
      }
      case "ack":
      case "saved":
        settle(message.id, message);
        return;
      case "error": {
        const error = new GameError(message.code, message.message);
        if (message.id !== null && pending.has(message.id)) settle(message.id, error);
        else emitter.emit("error", error);
        return;
      }
      case "snapshot": {
        const { t: _t, id, ...snapshot } = message;
        tick = snapshot.tick;
        for (const [name, data] of Object.entries(snapshot.channels)) latest.set(name, data);
        if (id !== null) settle(id, message);
        else emitter.emit("snapshot", snapshot);
        return;
      }
      case "channel":
        tick = Math.max(tick, message.tick);
        latest.set(message.name, message.data);
        emitter.emit(`channel:${message.name}`, message.data, message.tick);
        return;
      case "events":
        tick = message.tick;
        onEvents(message.events);
        emitter.emit("tick", {
          tick: message.tick,
          tps: message.tps,
          lagging: message.lagging,
          dropped: message.dropped,
        });
        return;
      case "lag":
        emitter.emit("lag", message.ticksBehind);
        return;
      case "corrupted": {
        const { t: _t, ...corruption } = message;
        emitter.emit("corrupted", corruption);
        return;
      }
    }
  };
  port.onmessage = onmessage;

  const control = async (value: SimControl) => {
    await request({ t: "control", control: value });
  };
  const ready = (message: WorkerMessage): RemoteSimInfo => {
    const { t: _t, id: _id, ...rest } = message as ReadyMessage;
    return rest;
  };

  return {
    get tick() {
      return tick;
    },
    get info() {
      return info;
    },
    init: async (init = {}) => ready(await request({ t: "init", ...init })),
    load: async (bytes, load = {}) => {
      // Une vue partielle d'un tampon est d'abord copiée : on ne transfère que ce qu'on envoie.
      const own =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
      const transfer = own.buffer instanceof ArrayBuffer ? [own.buffer] : [];
      return ready(await request({ t: "load", bytes: own as Uint8Array<ArrayBuffer>, ...load }, transfer));
    },
    dispatch: async (command) => {
      const message = await request({ t: "dispatch", command });
      return (message as { data: number }).data;
    },
    setSpeed: (speed) => control({ op: "speed", speed }),
    pause: () => control({ op: "pause" }),
    resume: () => control({ op: "resume" }),
    step: (ticks = 1) => control({ op: "step", ticks }),
    subscribe: async (channels) => {
      await request({ t: "subscribe", channels });
    },
    snapshot: async () => {
      const {
        t: _t,
        id: _id,
        ...snapshot
      } = (await request({ t: "snapshot" })) as Extract<WorkerMessage, { t: "snapshot" }>;
      return snapshot;
    },
    hash: async () => ((await request({ t: "hash" })) as { data: string }).data,
    save: async () => ((await request({ t: "save" })) as Extract<WorkerMessage, { t: "saved" }>).bytes,
    latest: (channel) => latest.get(channel),
    on: (event, listener) => emitter.on(event, listener as (...args: unknown[]) => void),
    close() {
      closed = true;
      port.onmessage = null;
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new GameError("DISCONNECTED", "Connexion à la simulation fermée."));
        pending.delete(id);
      }
      emitter.clear();
    },
  };
}
