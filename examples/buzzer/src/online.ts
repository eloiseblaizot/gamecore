/**
 * Le Buzzer du mode en ligne, avec sa banque de questions complète.
 * ⚠️ Importé uniquement par le serveur (et les tests) : jamais par le code du navigateur.
 */

import { createBuzzer } from "./game.js";
import { QUESTIONS } from "./questions.js";

export const buzzer = createBuzzer(QUESTIONS);
