/**
 * Faux `AudioContext` pour tester des bruitages et des ambiances sans navigateur.
 *
 *   import { FakeAudioContext } from "@gamecore/audio/testing";
 *   const ctx = new FakeAudioContext();
 *   const engine = createAudioEngine({ storageKey: "test", createContext: () => ctx as never, storage: null });
 *
 * Il est volontairement STRICT, comme les vrais navigateurs : une rampe exponentielle vers 0,
 * une valeur ou une date non finie, un `stop()` avant `start()` lèvent une erreur. Il garde
 * la trace des nœuds créés et des notes programmées, pour vérifier ce qui a été joué.
 */

export class FakeAudioParam {
  value: number;
  readonly events: { type: string; value: number; time: number }[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  private record(type: string, value: number, time: number): this {
    if (!Number.isFinite(value) || !Number.isFinite(time)) {
      throw new TypeError(`${type} : valeur ou date non finie (${value}, ${time})`);
    }
    if (time < 0) throw new RangeError(`${type} : date négative (${time})`);
    this.events.push({ type, value, time });
    this.value = value;
    return this;
  }

  setValueAtTime(value: number, time: number) {
    return this.record("set", value, time);
  }
  linearRampToValueAtTime(value: number, time: number) {
    return this.record("linear", value, time);
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    if (value <= 0) throw new RangeError(`rampe exponentielle vers ${value} (doit être > 0)`);
    return this.record("exponential", value, time);
  }
  setTargetAtTime(value: number, time: number, constant: number) {
    if (!(constant > 0)) throw new RangeError("constante de temps invalide");
    return this.record("target", value, time);
  }
  cancelScheduledValues(time: number) {
    return this.record("cancel", this.value, time);
  }
}

export class FakeAudioNode {
  readonly kind: string;
  readonly outputs: unknown[] = [];
  readonly context: FakeAudioContext;

  constructor(context: FakeAudioContext, kind: string) {
    this.context = context;
    this.kind = kind;
    context.nodes.push(this);
  }

  connect<T>(destination: T): T {
    this.outputs.push(destination);
    return destination;
  }

  disconnect(): void {
    this.outputs.length = 0;
  }
}

class FakeScheduledNode extends FakeAudioNode {
  startTime: number | null = null;
  stopTime: number | null = null;

  start(time = 0, _offset = 0): void {
    if (!Number.isFinite(time)) throw new TypeError("start : date non finie");
    if (this.startTime !== null) throw new Error("start() appelé deux fois");
    this.startTime = time;
    this.context.starts.push({ kind: this.kind, time });
  }

  stop(time = 0): void {
    if (!Number.isFinite(time)) throw new TypeError("stop : date non finie");
    if (this.startTime === null) throw new Error("stop() avant start()");
    this.stopTime = time;
  }
}

class FakeOscillator extends FakeScheduledNode {
  type = "sine";
  readonly frequency = new FakeAudioParam(440);
  readonly detune = new FakeAudioParam(0);
}

class FakeBufferSource extends FakeScheduledNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeAudioParam(1);
}

class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new RangeError(`canal ${channel} inexistant`);
    return data;
  }
}

export class FakeAudioContext {
  /** Horloge audio, à avancer à la main dans les tests. */
  currentTime = 0;
  /** Fréquence d'échantillonnage réduite : les tampons de bruit restent petits. */
  readonly sampleRate = 8000;
  state: "suspended" | "running" | "closed" = "running";
  readonly nodes: FakeAudioNode[] = [];
  /** Chaque son programmé (`start`) : type de nœud et date. */
  readonly starts: { kind: string; time: number }[] = [];
  readonly destination: FakeAudioNode;

  constructor(state: "suspended" | "running" = "running") {
    this.state = state;
    this.destination = new FakeAudioNode(this, "destination");
  }

  resume(): Promise<void> {
    if (this.state !== "closed") this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }

  createGain() {
    return Object.assign(new FakeAudioNode(this, "gain"), { gain: new FakeAudioParam(1) });
  }
  createOscillator() {
    return new FakeOscillator(this, "oscillator");
  }
  createBufferSource() {
    return new FakeBufferSource(this, "bufferSource");
  }
  createBiquadFilter() {
    return Object.assign(new FakeAudioNode(this, "biquad"), {
      type: "lowpass",
      frequency: new FakeAudioParam(350),
      Q: new FakeAudioParam(1),
      gain: new FakeAudioParam(0),
    });
  }
  createConvolver() {
    return Object.assign(new FakeAudioNode(this, "convolver"), { buffer: null as FakeAudioBuffer | null });
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeAudioNode(this, "compressor"), {
      threshold: new FakeAudioParam(-24),
      knee: new FakeAudioParam(30),
      ratio: new FakeAudioParam(12),
      attack: new FakeAudioParam(0.003),
      release: new FakeAudioParam(0.25),
    });
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
}
