/**
 * @gamecore/audio — son 100 % synthétisé (Web Audio) : instruments, bruitages génériques,
 * musique générative, moteur avec réglages. Liaisons React : `@gamecore/audio/react`.
 */

export {
  AudioEngine,
  DEFAULT_SOUND,
  createAudioEngine,
  type AudioEngineOptions,
  type SoundSettings,
} from "./engine.js";
export { MOODS, MusicSequencer, type BuiltinMood, type MoodDef } from "./music.js";
export { SFX, type SfxName, type SfxOptions, type SfxRecipe } from "./sfx.js";
export * as synth from "./synth.js";
export type { Bus, Kit } from "./synth.js";
