/**
 * Instruments synthétisés avec la Web Audio API (repris de DCDS).
 *
 * Aucun fichier audio : chaque note est fabriquée à la volée avec des oscillateurs, du bruit
 * et des filtres. C'est léger, ça marche hors ligne, et c'est libre de droits — on peut
 * streamer le jeu sans souci de copyright.
 *
 * Chaque instrument prend un `Kit` (contexte audio + bus de sortie), une date de départ `t`
 * sur l'horloge audio (`ctx.currentTime`), puis ses paramètres. Les hauteurs sont en notes
 * MIDI (60 = do central).
 */

export interface Bus {
  /** Entrée « sèche ». */
  input: AudioNode;
  /** Envoi vers la réverbération du bus. */
  send: AudioNode;
}

export interface Kit {
  ctx: AudioContext;
  bus: Bus;
  noise: AudioBuffer;
}

export const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

const EPS = 0.0001;

function out(kit: Kit, node: AudioNode, send = 0) {
  node.connect(kit.bus.input);
  if (send > 0) {
    const s = kit.ctx.createGain();
    s.gain.value = send;
    node.connect(s);
    s.connect(kit.bus.send);
  }
}

function osc(kit: Kit, type: OscillatorType, freq: number, t: number, stop: number) {
  const o = kit.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.start(t);
  o.stop(stop);
  return o;
}

function noise(kit: Kit, t: number, dur: number) {
  const s = kit.ctx.createBufferSource();
  s.buffer = kit.noise;
  s.loop = true;
  s.start(t, Math.random() * 1.5);
  s.stop(t + dur);
  return s;
}

function filt(kit: Kit, type: BiquadFilterType, freq: number, q = 0.7) {
  const f = kit.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function amp(kit: Kit) {
  const g = kit.ctx.createGain();
  g.gain.value = EPS;
  return g;
}

/** Enveloppe percussive (attaque rapide, décroissance exponentielle). */
function perc(g: GainNode, t: number, peak: number, decay: number, attack = 0.003) {
  g.gain.setValueAtTime(EPS, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, EPS * 2), t + attack);
  g.gain.exponentialRampToValueAtTime(EPS, t + attack + decay);
}

/** Enveloppe tenue (attaque, maintien, relâchement). */
function hold(g: GainNode, t: number, peak: number, attack: number, dur: number, release: number) {
  const end = t + Math.max(attack, dur);
  g.gain.setValueAtTime(EPS, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, end);
  g.gain.exponentialRampToValueAtTime(EPS, end + release);
}

// ------------------------------------------------------------------ mélodiques

export function marimba(kit: Kit, t: number, midi: number, vel = 0.3, send = 0.15) {
  const f = hz(midi);
  const g = amp(kit);
  const body = osc(kit, "sine", f, t, t + 0.7);
  const over = osc(kit, "sine", f * 3.95, t, t + 0.15);
  const og = kit.ctx.createGain();
  og.gain.setValueAtTime(0.35, t);
  og.gain.exponentialRampToValueAtTime(EPS, t + 0.08);
  body.connect(g);
  over.connect(og).connect(g);
  perc(g, t, vel, 0.5);
  out(kit, g, send);
}

export function pluck(kit: Kit, t: number, midi: number, vel = 0.25, send = 0.12) {
  const o = osc(kit, "triangle", hz(midi), t, t + 0.4);
  const f = filt(kit, "lowpass", 3200, 2);
  f.frequency.setValueAtTime(3200, t);
  f.frequency.exponentialRampToValueAtTime(500, t + 0.18);
  const g = amp(kit);
  o.connect(f).connect(g);
  perc(g, t, vel, 0.28, 0.002);
  out(kit, g, send);
}

export function bass(kit: Kit, t: number, midi: number, vel = 0.4, dur = 0.35) {
  const f = hz(midi);
  const g = amp(kit);
  osc(kit, "sine", f, t, t + dur + 0.2).connect(g);
  const tri = osc(kit, "triangle", f * 2, t, t + dur + 0.2);
  const tg = kit.ctx.createGain();
  tg.gain.value = 0.35;
  tri.connect(tg).connect(g);
  perc(g, t, vel, dur, 0.008);
  out(kit, g);
}

/** Piano électrique doux (synthèse FM). */
export function ep(kit: Kit, t: number, midi: number, vel = 0.15, dur = 1.2) {
  const f = hz(midi);
  const car = osc(kit, "sine", f, t, t + dur + 0.6);
  const mod = osc(kit, "sine", f, t, t + dur + 0.6);
  const idx = kit.ctx.createGain();
  idx.gain.setValueAtTime(f * 1.4, t);
  idx.gain.exponentialRampToValueAtTime(f * 0.08, t + 0.6);
  mod.connect(idx).connect(car.frequency);
  const g = amp(kit);
  car.connect(g);
  perc(g, t, vel, dur, 0.01);
  out(kit, g, 0.25);
}

export function lead(kit: Kit, t: number, midi: number, dur: number, vel = 0.12) {
  const f = hz(midi);
  const o = osc(kit, "sine", f, t, t + dur + 0.3);
  const o2 = osc(kit, "triangle", f, t, t + dur + 0.3);
  const lfo = osc(kit, "sine", 5.5, t, t + dur + 0.3);
  const depth = kit.ctx.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.25, dur));
  lfo.connect(depth);
  depth.connect(o.frequency);
  depth.connect(o2.frequency);
  const mix = kit.ctx.createGain();
  mix.gain.value = 0.3;
  o2.connect(mix);
  const g = amp(kit);
  o.connect(g);
  mix.connect(g);
  hold(g, t, vel, 0.02, dur, 0.15);
  out(kit, g, 0.3);
}

export function bell(kit: Kit, t: number, midi: number, vel = 0.15, decay = 1.6) {
  const f = hz(midi);
  const ratios = [1, 2.76, 5.4, 8.93];
  const gains = [1, 0.45, 0.22, 0.1];
  ratios.forEach((r, i) => {
    const g = amp(kit);
    osc(kit, "sine", f * r, t, t + decay).connect(g);
    perc(g, t, vel * gains[i], decay / (1 + i * 0.8), 0.002);
    out(kit, g, 0.4);
  });
}

export function pad(kit: Kit, t: number, midis: number[], dur: number, vel = 0.05, cutoff = 900) {
  const f = filt(kit, "lowpass", cutoff, 0.8);
  const g = amp(kit);
  f.connect(g);
  for (const m of midis) {
    for (const det of [-7, 7]) {
      const o = osc(kit, "sawtooth", hz(m), t, t + dur + 1);
      o.detune.value = det;
      o.connect(f);
    }
  }
  hold(g, t, vel, Math.min(0.5, dur / 2), dur, 0.8);
  out(kit, g, 0.35);
}

export function brass(kit: Kit, t: number, midi: number, dur: number, vel = 0.18) {
  const f = filt(kit, "lowpass", 400, 1.5);
  f.frequency.setValueAtTime(400, t);
  f.frequency.exponentialRampToValueAtTime(2600, t + 0.06);
  f.frequency.exponentialRampToValueAtTime(1300, t + 0.25);
  const g = amp(kit);
  for (const det of [-6, 6]) {
    const o = osc(kit, "sawtooth", hz(midi), t, t + dur + 0.3);
    o.detune.value = det;
    o.connect(f);
  }
  f.connect(g);
  hold(g, t, vel, 0.025, dur, 0.15);
  out(kit, g, 0.25);
}

export function choir(kit: Kit, t: number, midis: number[], dur: number, vel = 0.05) {
  const f = filt(kit, "bandpass", 900, 0.9);
  const g = amp(kit);
  f.connect(g);
  for (const m of midis) {
    const o = osc(kit, "sawtooth", hz(m), t, t + dur + 1);
    const lfo = osc(kit, "sine", 4.8 + Math.random(), t, t + dur + 1);
    const d = kit.ctx.createGain();
    d.gain.value = hz(m) * 0.008;
    lfo.connect(d).connect(o.frequency);
    o.connect(f);
  }
  hold(g, t, vel, 0.35, dur, 0.9);
  out(kit, g, 0.5);
}

/** Trombone « triste » avec vibrato (wah wah wah waaah). */
export function trombone(kit: Kit, t: number, midi: number, dur: number, vel = 0.22, vibrato = false) {
  const f = hz(midi);
  const o = osc(kit, "sawtooth", f, t, t + dur + 0.3);
  if (vibrato) {
    const lfo = osc(kit, "sine", 5.5, t, t + dur + 0.3);
    const d = kit.ctx.createGain();
    d.gain.setValueAtTime(0, t);
    d.gain.linearRampToValueAtTime(f * 0.035, t + 0.3);
    lfo.connect(d).connect(o.frequency);
  }
  const fl = filt(kit, "lowpass", 700, 3);
  fl.frequency.setValueAtTime(500, t);
  fl.frequency.linearRampToValueAtTime(1300, t + 0.08);
  fl.frequency.linearRampToValueAtTime(800, t + dur);
  const g = amp(kit);
  o.connect(fl).connect(g);
  hold(g, t, vel, 0.04, dur, 0.12);
  out(kit, g, 0.2);
}

// ------------------------------------------------------------------ percussions

export function kick(kit: Kit, t: number, vel = 0.6) {
  const o = osc(kit, "sine", 150, t, t + 0.35);
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  const g = amp(kit);
  o.connect(g);
  perc(g, t, vel, 0.3, 0.002);
  out(kit, g);
}

export function snare(kit: Kit, t: number, vel = 0.3, decay = 0.14, tone = 1800) {
  const n = noise(kit, t, decay + 0.05);
  const f = filt(kit, "bandpass", tone, 0.8);
  const g = amp(kit);
  n.connect(f).connect(g);
  perc(g, t, vel, decay, 0.001);
  out(kit, g, 0.15);
}

export function clap(kit: Kit, t: number, vel = 0.25) {
  const n = noise(kit, t, 0.25);
  const f = filt(kit, "bandpass", 1300, 1.2);
  const g = kit.ctx.createGain();
  g.gain.setValueAtTime(EPS, t);
  for (const dt of [0, 0.011, 0.022]) {
    g.gain.setValueAtTime(vel, t + dt);
    g.gain.exponentialRampToValueAtTime(vel * 0.2, t + dt + 0.009);
  }
  g.gain.setValueAtTime(vel * 0.8, t + 0.03);
  g.gain.exponentialRampToValueAtTime(EPS, t + 0.18);
  n.connect(f).connect(g);
  out(kit, g, 0.2);
}

export function hat(kit: Kit, t: number, vel = 0.05, decay = 0.04) {
  const n = noise(kit, t, decay + 0.03);
  const f = filt(kit, "highpass", 7500, 0.7);
  const g = amp(kit);
  n.connect(f).connect(g);
  perc(g, t, vel, decay, 0.001);
  out(kit, g);
}

export function shaker(kit: Kit, t: number, vel = 0.05) {
  const n = noise(kit, t, 0.1);
  const f = filt(kit, "bandpass", 6500, 1.5);
  const g = amp(kit);
  n.connect(f).connect(g);
  perc(g, t, vel, 0.06, 0.012);
  out(kit, g);
}

export function woodblock(kit: Kit, t: number, vel = 0.15, pitch = 1000) {
  const o = osc(kit, "sine", pitch, t, t + 0.1);
  o.frequency.exponentialRampToValueAtTime(pitch * 0.85, t + 0.05);
  const g = amp(kit);
  o.connect(g);
  perc(g, t, vel, 0.06, 0.001);
  out(kit, g, 0.1);
}

export function crash(kit: Kit, t: number, vel = 0.25, decay = 1.6) {
  const n = noise(kit, t, decay + 0.1);
  const f = filt(kit, "highpass", 3500, 0.5);
  const g = amp(kit);
  n.connect(f).connect(g);
  perc(g, t, vel, decay, 0.002);
  out(kit, g, 0.3);
}

export function timpani(kit: Kit, t: number, midi = 38, vel = 0.5) {
  const f = hz(midi);
  const o = osc(kit, "sine", f * 1.1, t, t + 1.2);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
  const g = amp(kit);
  o.connect(g);
  perc(g, t, vel, 1, 0.004);
  out(kit, g, 0.3);
  const n = noise(kit, t, 0.15);
  const nf = filt(kit, "lowpass", 400);
  const ng = amp(kit);
  n.connect(nf).connect(ng);
  perc(ng, t, vel * 0.6, 0.1, 0.001);
  out(kit, ng);
}

export function whoosh(kit: Kit, t: number, dur = 0.4, from = 400, to = 3000, vel = 0.12) {
  const n = noise(kit, t, dur + 0.05);
  const f = filt(kit, "bandpass", from, 1.6);
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = kit.ctx.createGain();
  g.gain.setValueAtTime(EPS, t);
  g.gain.linearRampToValueAtTime(vel, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  n.connect(f).connect(g);
  out(kit, g, 0.25);
}

export function blip(
  kit: Kit,
  t: number,
  from: number,
  to: number,
  dur = 0.06,
  vel = 0.12,
  type: OscillatorType = "sine",
) {
  const o = osc(kit, type, from, t, t + dur + 0.05);
  o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = amp(kit);
  o.connect(g);
  perc(g, t, vel, dur, 0.002);
  out(kit, g, 0.05);
}

/** Roulement de caisse claire qui monte en puissance. */
export function drumroll(kit: Kit, t: number, dur = 1.3, vel = 0.34) {
  let x = 0;
  while (x < dur) {
    const p = x / dur;
    snare(kit, t + x, vel * (0.25 + 0.75 * p * p), 0.06, 1600 + p * 600);
    x += 1 / (14 + 16 * p);
  }
}

export function siren(kit: Kit, t: number, dur = 1.1, vel = 0.14) {
  const o = osc(kit, "triangle", 650, t, t + dur + 0.1);
  const step = 0.24;
  for (let x = 0, hi = true; x < dur; x += step, hi = !hi) {
    o.frequency.setValueAtTime(hi ? 880 : 650, t + x);
  }
  const f = filt(kit, "lowpass", 2200);
  const g = amp(kit);
  o.connect(f).connect(g);
  hold(g, t, vel, 0.03, dur, 0.1);
  out(kit, g, 0.2);
}

export function buzzer(kit: Kit, t: number, dur = 0.7, vel = 0.14) {
  const f = filt(kit, "lowpass", 1400);
  const g = amp(kit);
  for (const fr of [110, 113.5]) osc(kit, "square", fr, t, t + dur + 0.1).connect(f);
  f.connect(g);
  hold(g, t, vel, 0.01, dur, 0.08);
  out(kit, g);
}

/** Foule qui applaudit (plein de petits claquements aléatoires). */
export function applause(kit: Kit, t: number, dur = 2.6, vel = 0.32) {
  const count = Math.round(dur * 70);
  for (let i = 0; i < count; i++) {
    const x = Math.random() ** 1.6 * dur;
    const n = noise(kit, t + x, 0.05);
    const f = filt(kit, "bandpass", 900 + Math.random() * 1800, 1.4);
    const g = amp(kit);
    n.connect(f).connect(g);
    perc(g, t + x, vel * (0.4 + Math.random() * 0.6) * (1 - (x / dur) * 0.7), 0.035, 0.001);
    out(kit, g, 0.25);
  }
}

/** Grincement (porte, coffre qui s'ouvre). */
export function creak(kit: Kit, t: number, dur = 0.35, vel = 0.1) {
  const o = osc(kit, "sawtooth", 75, t, t + dur + 0.05);
  const jitter = osc(kit, "square", 22, t, t + dur + 0.05);
  const jd = kit.ctx.createGain();
  jd.gain.value = 18;
  jitter.connect(jd).connect(o.frequency);
  const f = filt(kit, "bandpass", 500, 6);
  f.frequency.setValueAtTime(450, t);
  f.frequency.linearRampToValueAtTime(1400, t + dur);
  const g = amp(kit);
  o.connect(f).connect(g);
  hold(g, t, vel, 0.05, dur, 0.06);
  out(kit, g, 0.15);
}

// ------------------------------------------------------------------ utilitaires

export function makeNoise(ctx: AudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Réponse impulsionnelle synthétique pour une réverb de petite salle. */
export function makeImpulse(ctx: AudioContext, seconds = 2, decay = 3): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return buf;
}
