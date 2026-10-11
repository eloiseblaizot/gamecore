/**
 * Questions du mode démo. Elles sont envoyées au navigateur (la démo s'y joue entièrement) :
 * c'est pourquoi elles sont DISTINCTES de la banque du mode en ligne.
 */

import type { Question } from "./questions.js";

export const DEMO_QUESTIONS: readonly Question[] = [
  {
    text: "Combien de jours compte une année bissextile ?",
    choices: ["364", "365", "366", "367"],
    answer: 2,
  },
  {
    text: "Quel fruit est utilisé pour faire le guacamole ?",
    choices: ["La mangue", "L'avocat", "Le citron vert", "La papaye"],
    answer: 1,
  },
  {
    text: "De quelle couleur est le cheval blanc d'Henri IV ?",
    choices: ["Noir", "Gris", "Blanc", "Alezan"],
    answer: 2,
  },
  {
    text: "Quel animal est l'emblème de la France sur les maillots de rugby ?",
    choices: ["Le coq", "L'aigle", "Le lion", "Le loup"],
    answer: 0,
  },
  { text: "Combien de cases compte un échiquier ?", choices: ["36", "49", "64", "81"], answer: 2 },
  {
    text: "Quelle est la planète la plus proche du Soleil ?",
    choices: ["Vénus", "Mercure", "Mars", "La Terre"],
    answer: 1,
  },
  {
    text: "Dans quel sport utilise-t-on un volant ?",
    choices: ["Le tennis", "Le squash", "Le badminton", "Le ping-pong"],
    answer: 2,
  },
  {
    text: "Quel est le symbole chimique de l'eau ?",
    choices: ["CO2", "O2", "H2O", "NaCl"],
    answer: 2,
  },
  {
    text: "Combien de couleurs compte un arc-en-ciel (tradition française) ?",
    choices: ["5", "6", "7", "8"],
    answer: 2,
  },
  {
    text: "Quel personnage dit « D'oh ! » ?",
    choices: ["Homer Simpson", "Fred Pierrafeu", "Peter Griffin", "Bob l'éponge"],
    answer: 0,
  },
];
