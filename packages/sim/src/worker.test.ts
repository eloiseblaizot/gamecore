import { GameError } from "@gamecore/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toy } from "./__fixtures__/toy.js";
import { defineSimulation } from "./definition.js";
import { createFakeClock } from "./fake-clock.js";
import { localPort } from "./local-port.js";
import { hostMessageSchema, workerMessageSchema, type SimPort } from "./protocol.js";
import { createSimulation } from "./simulation.js";
import { connectSimulation } from "./worker-client.js";
import { exposeSimulation, type ExposeOptions } from "./worker.js";

/** Laisse passer les messages en attente (livrés en micro-tâches). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const setup = (runner: ExposeOptions["runner"] = {}) => {
  const clock = createFakeClock();
  const [pagePort, simPort] = localPort();
  const exposed = exposeSimulation(toy, simPort, {
    runner: { now: clock.now, schedule: clock.schedule, cancel: clock.cancel, ...runner },
  });
  const remote = connectSimulation<typeof toy>(pagePort);
  return { clock, exposed, remote, pagePort, simPort };
};

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as GameError;
  }
  throw new Error("une erreur était attendue");
};

describe("protocole", () => {
  it("valide les messages de la page", () => {
    expect(hostMessageSchema.safeParse({ t: "init", id: 1, seed: "s" }).success).toBe(true);
    expect(
      hostMessageSchema.safeParse({ t: "control", id: 1, control: { op: "step", ticks: 3 } }).success,
    ).toBe(true);
    for (const bad of [
      null,
      { t: "inconnu", id: 1 },
      { t: "init", id: -1 },
      { t: "init", id: 1, extra: true },
      { t: "control", id: 1, control: { op: "speed", speed: 100 } },
      { t: "control", id: 1, control: { op: "step", ticks: 0 } },
      { t: "subscribe", id: 1, channels: ["x".repeat(65)] },
      { t: "load", id: 1, bytes: [1, 2, 3] },
    ]) {
      expect(hostMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("valide les messages de la simulation", () => {
    expect(
      workerMessageSchema.safeParse({ t: "error", id: null, code: "RULE", message: "non" }).success,
    ).toBe(true);
    expect(
      workerMessageSchema.safeParse({ t: "error", id: null, code: "INVENTÉ", message: "?" }).success,
    ).toBe(false);
    expect(workerMessageSchema.safeParse({ t: "lag", tick: 1, ticksBehind: 0 }).success).toBe(false);
    expect(workerMessageSchema.safeParse({ t: "saved", id: 1, bytes: "abc" }).success).toBe(false);
  });
});

describe("exposeSimulation + connectSimulation", () => {
  it("démarre une simulation et publie ready, snapshot, événements et canaux", async () => {
    const { clock, exposed, remote } = setup();
    const seen: string[] = [];
    remote.on("ready", () => seen.push("ready"));
    remote.on("snapshot", (snap) => seen.push(`snapshot@${snap.tick}`));
    remote.on("event:created", (data, tick) => seen.push(`created ${JSON.stringify(data)}@${tick}`));
    const grids: unknown[] = [];
    remote.on("channel:grid", (data) => grids.push(data));
    const ticks: number[] = [];
    remote.on("tick", (info) => ticks.push(info.tick));

    const info = await remote.init({ seed: "s", settings: { size: 4 } });
    expect(info).toEqual({
      tick: 0,
      seed: "s",
      settings: { size: 4, growth: 1 },
      ticksPerSecond: 10,
      speed: 1,
      paused: false,
      channels: ["grid", "stats", "slow"],
    });
    expect(remote.info).toEqual(info);
    await flush();
    expect(seen).toEqual(["ready", "snapshot@0", 'created {"size":4}@0']);

    clock.advance(1000);
    await flush();
    expect(remote.tick).toBe(10);
    expect(ticks.at(-1)).toBe(10);
    expect(grids).toHaveLength(10);
    // Le canal transféré est une copie : la simulation garde son propre tampon.
    const last = grids.at(-1) as Uint16Array;
    expect(last).toBeInstanceOf(Uint16Array);
    expect(last).toEqual(exposed.sim!.state.cells);
    expect(last.buffer).not.toBe(exposed.sim!.state.cells.buffer);
    expect(remote.latest("grid")).toBe(last);
    expect(remote.latest("slow")).toBe(9);
    expect(await remote.hash()).toBe(exposed.sim!.hash());
  });

  it("corrèle les commandes : numéro, refus de schéma, commande système interdite", async () => {
    const { clock, remote } = setup();
    await remote.init({ seed: "s" });
    expect(await remote.dispatch({ type: "paint", x: 1, y: 1, value: 3 })).toBe(1);
    const invalid = await rejection(remote.dispatch({ type: "paint" } as never));
    expect(invalid).toBeInstanceOf(GameError);
    expect(invalid.code).toBe("BAD_REQUEST");
    expect((await rejection(remote.dispatch({ type: "pulse", amount: 1 } as never))).code).toBe("FORBIDDEN");

    const rejected: unknown[] = [];
    remote.on("commandRejected", (data) => rejected.push(data));
    const seq = await remote.dispatch({ type: "paint", x: 50, y: 1, value: 3 });
    clock.advance(100);
    await flush();
    expect(rejected).toEqual([{ seq, key: null, origin: "host", message: "Case hors de la grille." }]);
  });

  it("pilote le cadenceur : pause, pas à pas, vitesse, reprise", async () => {
    const { clock, remote } = setup();
    await remote.init({ seed: "s", paused: true });
    clock.advance(1000);
    await flush();
    expect(remote.tick).toBe(0);
    await remote.step(3);
    await flush();
    expect(remote.tick).toBe(3);
    await remote.setSpeed(2);
    await remote.resume();
    clock.advance(1000);
    await flush();
    expect(remote.tick).toBe(23);
    await remote.pause();
    clock.advance(1000);
    await flush();
    expect(remote.tick).toBe(23);
    expect((await rejection(remote.setSpeed(1000))).code).toBe("BAD_REQUEST");
  });

  it("ne publie que les canaux souscrits", async () => {
    const { clock, remote } = setup();
    await remote.init({ seed: "s" });
    let grids = 0;
    remote.on("channel:grid", () => grids++);
    await remote.subscribe(["slow"]);
    clock.advance(1000);
    await flush();
    expect(grids).toBe(0);
    expect(remote.latest("slow")).toBe(9);
    await remote.subscribe(null);
    clock.advance(100);
    await flush();
    expect(grids).toBe(1);
  });

  it("renvoie le snapshot complet à la demande", async () => {
    const { remote } = setup();
    await remote.init({ seed: "s", settings: { size: 2 }, paused: true });
    await remote.step(2);
    const snap = await remote.snapshot();
    expect(snap.tick).toBe(2);
    expect(snap.full).toMatchObject({ size: 2, tick: 2 });
    expect(Object.keys(snap.channels)).toEqual(["grid", "stats", "slow"]);
  });

  it("sauvegarde puis recharge à l'identique (octets transférés)", async () => {
    const { clock, remote } = setup();
    await remote.init({ seed: "s" });
    await remote.dispatch({ type: "pulseIn", key: "p", delay: 50, amount: 2 });
    clock.advance(1500);
    await flush();
    const hash = await remote.hash();
    const bytes = await remote.save();
    expect(bytes).toBeInstanceOf(Uint8Array);

    const copy = bytes.slice();
    const info = await remote.load(bytes, { paused: true });
    expect(info.tick).toBe(15);
    expect(info.paused).toBe(true);
    expect(bytes.byteLength).toBe(0); // transféré
    expect(await remote.hash()).toBe(hash);

    // Une vue partielle est copiée avant transfert : le tampon d'origine reste intact.
    const backing = new Uint8Array(copy.length + 4);
    backing.set(copy, 2);
    const view = backing.subarray(2, 2 + copy.length);
    await remote.load(view);
    expect(backing.byteLength).toBe(copy.length + 4);
    expect((await rejection(remote.load(new Uint8Array([1, 2, 3])))).code).toBe("BAD_REQUEST");
  });

  it("refuse les requêtes avant init et les messages invalides", async () => {
    const { remote, pagePort } = setup();
    expect((await rejection(remote.dispatch({ type: "fragile" }))).message).toMatch(/non démarrée/);
    const errors: GameError[] = [];
    remote.on("error", (err) => errors.push(err));
    pagePort.postMessage({ t: "dispatch", id: 999_999 }); // sans commande : invalide, id inconnu de la page
    pagePort.postMessage("n'importe quoi");
    await flush();
    expect(errors.map((e) => e.code)).toEqual(["BAD_REQUEST", "BAD_REQUEST"]);
    expect((await rejection(remote.init({ settings: { size: 1 } }))).code).toBe("BAD_REQUEST");
  });

  it("ignore les messages invalides venus de la simulation", async () => {
    const [pagePort, simPort] = localPort();
    const remote = connectSimulation(pagePort);
    const errors: GameError[] = [];
    remote.on("error", (err) => errors.push(err));
    simPort.postMessage({ t: "ready", id: "x" });
    simPort.postMessage({ t: "error", id: null, code: "RULE", message: "spontanée" });
    simPort.postMessage({ t: "ack", id: 42 }); // aucune requête 42 : ignoré
    await flush();
    expect(errors.map((e) => e.message)).toEqual(["Message invalide reçu de la simulation.", "spontanée"]);
  });

  it("rejette une requête sans réponse (TIMEOUT) et à la fermeture (DISCONNECTED)", async () => {
    const silent: SimPort = { postMessage: () => {}, onmessage: null };
    const remote = connectSimulation(silent, { requestTimeoutMs: 5 });
    expect((await rejection(remote.hash())).code).toBe("TIMEOUT");

    const other = connectSimulation({ postMessage: () => {}, onmessage: null });
    const pending = other.hash();
    other.close();
    expect((await rejection(pending)).code).toBe("DISCONNECTED");
    expect((await rejection(other.hash())).code).toBe("DISCONNECTED");
  });

  it("close côté simulation arrête le cadenceur et les réponses", async () => {
    const { clock, exposed, remote } = setup();
    await remote.init({ seed: "s" });
    exposed.close();
    clock.advance(1000);
    expect(exposed.sim!.tick).toBe(0);
  });
});

describe("corruption et retard", () => {
  it("publie corrupted et lag", async () => {
    let now = 0;
    const frames: (() => void)[] = [];
    const [pagePort, simPort] = localPort();
    exposeSimulation(toy, simPort, {
      runner: { now: () => now, schedule: (fn) => frames.push(fn), cancel: () => {}, maxTicksPerFrame: 3 },
    });
    const remote = connectSimulation<typeof toy>(pagePort);
    const lags: number[] = [];
    const corruptions: unknown[] = [];
    remote.on("lag", (behind) => lags.push(behind));
    remote.on("corrupted", (info) => corruptions.push(info));

    await remote.init({ seed: "s" });
    await remote.dispatch({ type: "armCrash", tick: 5 });
    now = 1000; // 10 ticks dus, 3 au plus par frame
    frames.shift()!();
    await flush();
    expect(lags).toEqual([7]);
    expect(remote.tick).toBe(3);
    now = 2000;
    frames.shift()!();
    await flush();
    expect(corruptions).toEqual([{ tick: 5, system: "crash", cause: "boum" }]);
    expect((await rejection(remote.save())).code).toBe("INTERNAL");
  });
});

describe("canaux transférés et erreurs internes", () => {
  const raw = defineSimulation({
    id: "raw",
    version: 1,
    settings: { schema: z.strictObject({ broken: z.boolean() }), defaults: { broken: false } },
    commands: z.strictObject({ type: z.literal("noop") }),
    create: (ctx) => ({ buffer: new Uint8Array([1, 2, 3, 4]).buffer, broken: ctx.settings.broken }),
    apply() {},
    systems: [],
    snapshot: {
      full(state) {
        if (state.broken) throw new Error("snapshot en panne");
        return null;
      },
      channels: {
        raw: { every: 1, build: (state) => state.buffer, transfer: true },
        plain: { every: 1, build: () => ({ n: 1 }), transfer: true },
      },
    },
    codec: { encode: () => new Uint8Array(0), decode: () => ({ buffer: new ArrayBuffer(4), broken: false }) },
  });

  it("copie puis transfère un ArrayBuffer, et laisse passer une donnée non binaire", async () => {
    const [pagePort, simPort] = localPort();
    const exposed = exposeSimulation(raw, simPort);
    const remote = connectSimulation<typeof raw>(pagePort);
    const received: unknown[] = [];
    remote.on("channel:raw", (data) => received.push(data));
    remote.on("channel:plain", (data) => received.push(data));
    await remote.init({ paused: true });
    await remote.step();
    await flush();
    expect(received).toEqual([new Uint8Array([1, 2, 3, 4]).buffer, { n: 1 }]);
    expect(exposed.sim!.state.buffer.byteLength).toBe(4); // la simulation garde le sien
    exposed.close();
  });

  it("renvoie INTERNAL pour une exception inattendue, sans remplacer la simulation", async () => {
    const [pagePort, simPort] = localPort();
    const exposed = exposeSimulation(raw, simPort);
    const remote = connectSimulation<typeof raw>(pagePort);
    await remote.init({ paused: true });
    const first = exposed.sim;
    const error = await rejection(remote.init({ settings: { broken: true } }));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("snapshot en panne");
    expect(exposed.sim).toBe(first);
    exposed.close();
  });
});

describe("localPort", () => {
  it("livre de façon asynchrone, clone et transfère comme un Worker", async () => {
    const [a, b] = localPort();
    const received: unknown[] = [];
    (b as { onmessage: unknown }).onmessage = (event: { data: unknown }) => received.push(event.data);
    const payload = { n: 1, cells: new Uint8Array([1, 2]) };
    a.postMessage(payload, { transfer: [payload.cells.buffer] });
    expect(received).toEqual([]);
    expect(payload.cells.byteLength).toBe(0); // transféré
    await flush();
    expect(received).toEqual([{ n: 1, cells: new Uint8Array([1, 2]) }]);
    expect(() => a.postMessage({ fn: () => {} })).toThrow();
  });

  it("peut ne pas cloner (références partagées)", async () => {
    const [a, b] = localPort({ clone: false });
    const received: unknown[] = [];
    (b as { onmessage: unknown }).onmessage = (event: { data: unknown }) => received.push(event.data);
    const payload = { n: 1 };
    a.postMessage(payload);
    await flush();
    expect(received[0]).toBe(payload);
  });

  it("permet de piloter une simulation créée côté page sans Worker", async () => {
    const spy = vi.spyOn(globalThis, "queueMicrotask");
    const { remote } = setup();
    await remote.init({ seed: "s", paused: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    // Même graine, même hash qu'une simulation en mémoire.
    expect(await remote.hash()).toBe(createSimulation(toy, { seed: "s" }).hash());
  });
});
