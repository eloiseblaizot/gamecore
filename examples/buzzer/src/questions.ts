/**
 * Banque de questions du quiz.
 *
 * ⚠️ Ce fichier contient les réponses : il ne doit être importé QUE par les règles du jeu
 * (exécutées sur le serveur). Le code du navigateur n'importe le jeu qu'en `import type`,
 * ce qui garantit que les réponses ne finissent pas dans le JavaScript envoyé aux joueurs
 * (vérifié par un test de bout en bout).
 */

export interface Question {
  text: string;
  choices: [string, string, string, string];
  /** Index de la bonne réponse dans `choices`. */
  answer: 0 | 1 | 2 | 3;
}

export const QUESTIONS: readonly Question[] = [
  {
    text: "Quelle est la capitale de l'Australie ?",
    choices: ["Sydney", "Canberra", "Melbourne", "Perth"],
    answer: 1,
  },
  { text: "Combien de cœurs possède une pieuvre ?", choices: ["1", "2", "3", "8"], answer: 2 },
  {
    text: "Quel élément chimique a pour symbole « Au » ?",
    choices: ["Argent", "Aluminium", "Or", "Argon"],
    answer: 2,
  },
  {
    text: "Dans quel pays se trouve la ville de Tombouctou ?",
    choices: ["Mali", "Niger", "Sénégal", "Maroc"],
    answer: 0,
  },
  {
    text: "Quel est le plus long fleuve de France ?",
    choices: ["La Seine", "Le Rhône", "La Garonne", "La Loire"],
    answer: 3,
  },
  {
    text: "Combien de joueurs compte une équipe de rugby à XV sur le terrain ?",
    choices: ["11", "13", "15", "17"],
    answer: 2,
  },
  {
    text: "Qui a peint « La Nuit étoilée » ?",
    choices: ["Claude Monet", "Vincent van Gogh", "Paul Cézanne", "Edvard Munch"],
    answer: 1,
  },
  {
    text: "Quelle planète est surnommée la « planète rouge » ?",
    choices: ["Vénus", "Jupiter", "Mars", "Mercure"],
    answer: 2,
  },
  {
    text: "En quelle année l'Homme a-t-il marché sur la Lune pour la première fois ?",
    choices: ["1965", "1969", "1972", "1975"],
    answer: 1,
  },
  {
    text: "Quel animal est le plus rapide sur terre ?",
    choices: ["Le lion", "L'antilope", "Le guépard", "Le lévrier"],
    answer: 2,
  },
  {
    text: "Quelle est la langue la plus parlée au monde (locuteurs natifs) ?",
    choices: ["L'anglais", "L'espagnol", "Le hindi", "Le mandarin"],
    answer: 3,
  },
  {
    text: "Combien de côtés a un hexagone ?",
    choices: ["5", "6", "7", "8"],
    answer: 1,
  },
  {
    text: "Quel océan borde la côte ouest de la France ?",
    choices: ["L'océan Atlantique", "L'océan Indien", "L'océan Pacifique", "L'océan Arctique"],
    answer: 0,
  },
  {
    text: "Qui a écrit « Les Misérables » ?",
    choices: ["Émile Zola", "Gustave Flaubert", "Victor Hugo", "Alexandre Dumas"],
    answer: 2,
  },
  {
    text: "Quel est le plus grand mammifère du monde ?",
    choices: ["L'éléphant d'Afrique", "La baleine bleue", "Le cachalot", "La girafe"],
    answer: 1,
  },
  {
    text: "Quel pays a remporté la Coupe du monde de football 2018 ?",
    choices: ["Le Brésil", "L'Allemagne", "La France", "La Croatie"],
    answer: 2,
  },
  {
    text: "Combien de minutes dure une mi-temps de football ?",
    choices: ["35", "40", "45", "50"],
    answer: 2,
  },
  {
    text: "Quel gaz les plantes absorbent-elles pour la photosynthèse ?",
    choices: ["L'oxygène", "L'azote", "Le dioxyde de carbone", "L'hélium"],
    answer: 2,
  },
  {
    text: "Quelle console de Nintendo est sortie en 2017 ?",
    choices: ["La Wii U", "La Switch", "La GameCube", "La 3DS"],
    answer: 1,
  },
  {
    text: "Quel est l'os le plus long du corps humain ?",
    choices: ["L'humérus", "Le tibia", "Le fémur", "Le radius"],
    answer: 2,
  },
  {
    text: "De quel pays la pizza margherita est-elle originaire ?",
    choices: ["L'Italie", "La Grèce", "L'Espagne", "La France"],
    answer: 0,
  },
  {
    text: "Combien de pattes a une araignée ?",
    choices: ["6", "8", "10", "12"],
    answer: 1,
  },
  {
    text: "Quel instrument a 88 touches ?",
    choices: ["L'accordéon", "L'orgue", "Le piano", "Le synthétiseur"],
    answer: 2,
  },
  {
    text: "Dans quelle ville se trouve le musée du Louvre ?",
    choices: ["Lyon", "Paris", "Bordeaux", "Lille"],
    answer: 1,
  },
];
