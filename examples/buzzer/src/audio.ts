/** Le son du Buzzer : moteur synthétisé de gamecore, réglages mémorisés pour ce jeu. */

import { createAudioEngine } from "@gamecore/audio";

export const audio = createAudioEngine({ storageKey: "buzzer-audio" });
