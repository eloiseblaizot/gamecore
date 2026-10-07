# Contribuer à gamecore

## Prérequis

- Node.js 22 ou plus (développé avec Node 24, voir `.nvmrc`).
- pnpm 11 (`corepack enable` suffit : la version est fixée dans `package.json`).

```bash
pnpm install          # installe tout et active les hooks Git (husky)
pnpm test             # tests unitaires et d'intégration (Vitest)
pnpm test:e2e         # tests de bout en bout (Playwright)
pnpm verify           # format + lint + typage + tests + build : à lancer avant de pousser
```

## Langue

- **Code** (noms de variables, de fonctions, de fichiers) : anglais.
- **Commentaires, documentation, messages affichés aux joueurs, descriptions de commit** : français.

## Conventions de commit

Les messages suivent [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/). Un hook
`commit-msg` (commitlint) refuse les messages non conformes.

```
type(portée): description courte, en minuscules, sans point final

Corps facultatif : le pourquoi du changement, en phrases ou en liste à puces.

BREAKING CHANGE: description d'un changement incompatible (le cas échéant)
```

### Types

| Type       | Usage                                                      |
| ---------- | ---------------------------------------------------------- |
| `feat`     | Nouvelle fonctionnalité                                    |
| `fix`      | Correction de bug                                          |
| `docs`     | Documentation seule                                        |
| `test`     | Ajout ou correction de tests                               |
| `refactor` | Réorganisation du code sans changement de comportement     |
| `perf`     | Amélioration de performances                               |
| `style`    | Mise en forme (espaces, virgules…), sans effet sur le code |
| `build`    | Système de build, dépendances                              |
| `ci`       | Intégration continue                                       |
| `chore`    | Maintenance diverse (outillage, configuration)             |
| `revert`   | Annulation d'un commit précédent                           |

### Portées

| Portée     | Périmètre                                                         |
| ---------- | ----------------------------------------------------------------- |
| `core`     | `packages/core` : définition de jeu, moteur, protocole            |
| `server`   | `packages/server` : runtime de salon, modules, transports serveur |
| `client`   | `packages/client` : client de jeu, transports navigateur          |
| `react`    | `packages/react` : hooks et composants                            |
| `discord`  | Intégration Discord (connexion, Activity)                         |
| `partykit` | Adaptateur PartyKit                                               |
| `example`  | Jeux d'exemple (`examples/`)                                      |
| `e2e`      | Tests de bout en bout (`e2e/`)                                    |
| `security` | Durcissement transverse                                           |
| `repo`     | Racine du monorepo, outillage                                     |
| `ci`       | Workflows GitHub                                                  |
| `deps`     | Mises à jour de dépendances                                       |
| `docs`     | Documentation transverse (`docs/`)                                |

### Exemples

```
feat(server): ajoute le module manettes avec relais des entrées vers l'écran
fix(client): reprend la session après un rechargement de page sur iOS
docs(core): documente le cycle de vie d'une action
test(e2e): couvre la reconnexion d'un joueur en pleine partie
```

## Règles de conception

- **Les règles ne vivent que dans le jeu** (`defineGame`) : fonctions pures, testées sans serveur.
- **Le serveur fait autorité** : un client envoie des intentions, jamais un état.
- **Aucun secret dans la vue publique** : ce qui est privé passe par `views.private`.
- **Tout ce qui vient du réseau est validé** (zod, tailles, débit) avant d'être utilisé.
- **Chaque fonctionnalité arrive avec ses tests** ; un parcours joueur arrive avec son test E2E.
- **Commentaires** : expliquer le _pourquoi_ (choix, contraintes, pièges), pas paraphraser le code.
