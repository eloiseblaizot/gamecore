# 0001 — Monorepo pnpm et paquets ESM compilés par `tsc`

- **Statut** : acceptée (2026-10-07)

## Contexte

gamecore doit servir de base à plusieurs jeux, développés ici (exemples) ou dans leurs propres dépôts. Les briques
(cœur, serveur, client, React, puis Discord, PartyKit…) doivent pouvoir être utilisées séparément, et un jeu ne doit
embarquer que ce dont il a besoin.

## Décision

- Un **monorepo pnpm** : `packages/*` (briques publiables, portée `@gamecore`), `examples/*` (jeux d'exemple), `e2e/`.
- Chaque paquet est **ESM uniquement**, compilé par `tsc` (JavaScript + déclarations dans `dist/`), sans bundler.
- Les exports déclarent une condition **`source`** pointant vers `src/` : en développement (Vite, Vitest, tsx,
  typage), les paquets sont lus depuis leurs sources, sans build intermédiaire. Le build (`tsconfig.build.json`)
  n'utilise que `dist/`.
- Les fonctionnalités optionnelles lourdes sont des **sous-chemins** (`@gamecore/server/socket-io`,
  `@gamecore/client/local`…) avec des dépendances pair optionnelles.

## Conséquences

- Modifier le cœur et voir l'effet dans l'exemple est immédiat.
- Publier les paquets demandera de choisir un registre et une portée (npm public, GitHub Packages).
- pnpm isole strictement les dépendances : un paquet qui oublie de déclarer une dépendance échoue tout de suite.
