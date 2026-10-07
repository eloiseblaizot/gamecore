/**
 * Conventions de commit : Conventional Commits (https://www.conventionalcommits.org/fr/).
 *
 *   type(portée): description courte en français, à l'impératif ou au présent
 *
 * Voir CONTRIBUTING.md pour la liste des types et des portées.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Portées autorisées : une par paquet, plus les sujets transverses.
    "scope-enum": [
      2,
      "always",
      [
        "core",
        "server",
        "client",
        "react",
        "discord",
        "partykit",
        "example",
        "e2e",
        "repo",
        "ci",
        "deps",
        "docs",
        "security",
      ],
    ],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 120],
  },
};
