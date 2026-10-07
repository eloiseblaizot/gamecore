# gamecore

Moteur modulaire pour nos jeux web multijoueurs : **salons à code**, **écran de l'hôte**, **téléphones en manettes**,
serveur **autoritaire** et **sécurisé**, transports interchangeables (Socket.io aujourd'hui, PartyKit ensuite) et
intégration **Discord** (connexion et Activity). Né de l'expérience de [DCDS](https://github.com/eloiseblaizot/DCDS),
il sert de base commune à tous les prochains jeux.

> Un jeu = quelques fonctions pures (`defineGame`). Le moteur s'occupe du reste : salons, reconnexions, secrets,
> minuteurs, sécurité, synchronisation des écrans et des téléphones.

```ts
import { defineGame } from "@gamecore/core";
import { z } from "zod";

export const pileOuFace = defineGame({
  id: "pile-ou-face",
  name: "Pile ou face",
  minPlayers: 2,
  maxPlayers: 8,
  settings: {
    schema: z.strictObject({ manches: z.number().int().min(1).max(10) }),
    defaults: { manches: 3 },
  },
  actions: z.strictObject({ type: z.literal("parier"), face: z.enum(["pile", "face"]) }),
  setup: (ctx) => ({ paris: {} as Record<string, string>, scores: {} as Record<string, number> }),
  reduce(etat, action, ctx) {
    const joueur = ctx.requirePlayer();
    if (etat.paris[joueur]) ctx.reject("Tu as déjà parié !");
    etat.paris[joueur] = action.face;
  },
  views: {
    public: (etat) => ({ ontParie: Object.keys(etat.paris), scores: etat.scores }), // ce que voit l'écran
    private: (etat, joueur) => ({ monPari: etat.paris[joueur] ?? null }), // ce que voit SON téléphone
  },
});
```

## Ce que fournit le moteur

| Brique                                                                                            | Paquet                                                     | État |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---- |
| Définition de jeu, moteur pur et déterministe, protocole                                          | `@gamecore/core`                                           | ✅   |
| Salons à code, host, spectateurs, verrouillage, expulsion                                         | `@gamecore/server`                                         | ✅   |
| Écran de l'hôte (vue publique, droits d'admin par jeton)                                          | `@gamecore/server` + `@gamecore/react`                     | ✅   |
| Téléphones en manettes (actions, entrées temps réel, QR code, joystick, vibrations, écran allumé) | `@gamecore/react` + module `controller`                    | ✅   |
| Chat (canaux, audiences secrètes, anti-spam)                                                      | module `chat`                                              | ✅   |
| Reprise de session (rechargement, réseau coupé)                                                   | `@gamecore/client`                                         | ✅   |
| Transport Socket.io (serveur Node)                                                                | `@gamecore/server/socket-io`, `@gamecore/client/socket-io` | ✅   |
| Transport local (mode démo, tests)                                                                | `@gamecore/client/local`                                   | ✅   |
| Transport PartyKit (Cloudflare)                                                                   | —                                                          | 🔜   |
| Connexion Discord (OAuth2 PKCE) + Discord Activity                                                | `@gamecore/discord`                                        | ✅   |
| Bots, son synthétisé, vidéo LiveKit (repris de DCDS)                                              | —                                                          | 🔜   |

Détail et prochaines étapes : [feuille de route](docs/feuille-de-route.md).

## Essayer en 1 minute

```bash
corepack enable        # active pnpm (version fixée dans package.json)
pnpm install
pnpm dev:buzzer        # jeu d'exemple : http://localhost:5173
```

Clique sur « Créer une partie » (c'est l'écran de l'hôte), puis ouvre le lien du QR code dans un autre onglet ou sur
ton téléphone : tu as une manette. Voir [examples/buzzer](examples/buzzer/README.md).

## Documentation

|                                                 |                                                                |
| ----------------------------------------------- | -------------------------------------------------------------- |
| 🎮 [Créer un jeu](docs/creer-un-jeu.md)         | Le guide pas à pas : règles, vues, serveur, interface, tests   |
| 🧱 [Architecture](docs/architecture.md)         | Paquets, cycle de vie d'un salon, flux d'un message            |
| 🧩 [Modules](docs/modules.md)                   | Écran de l'hôte, manettes, chat, transports… et écrire le sien |
| 🔌 [Protocole](docs/protocole.md)               | Messages échangés, codes d'erreur, limites                     |
| 🎧 [Discord](docs/discord.md)                   | Connexion Discord et Discord Activity                          |
| 🔒 [Sécurité](docs/securite.md)                 | Modèle de menace, garde-fous, limites connues                  |
| 🧪 [Tests](docs/tests.md)                       | Unitaires, intégration, bout en bout, couverture               |
| 🚀 [Déploiement](docs/deploiement.md)           | Mettre un jeu en ligne (Node, proxy, HTTPS)                    |
| 🗺️ [Feuille de route](docs/feuille-de-route.md) | Ce qui arrive ensuite                                          |
| 📐 [Décisions d'architecture](docs/adr/)        | Pourquoi le moteur est construit ainsi                         |
| 🤝 [Contribuer](CONTRIBUTING.md)                | Conventions de code et de commit                               |

## Scripts

```bash
pnpm test           # tests unitaires et d'intégration (Vitest)
pnpm test:e2e       # tests de bout en bout (Playwright)
pnpm test:coverage  # couverture (seuils vérifiés en CI)
pnpm lint           # ESLint (règles typées)
pnpm typecheck      # TypeScript
pnpm build          # build des paquets (dist/)
pnpm verify         # tout ce qui précède sauf l'E2E : à lancer avant de pousser
```

## Structure

```
packages/
  core/      Définition de jeu, moteur pur, hasard déterministe, protocole, nettoyage des saisies
  server/    Runtime de salon autoritaire, sécurité, modules (manettes, chat), Socket.io, outils de test
  client/    Client de jeu, reprise de session, transports navigateur (Socket.io, local)
  react/     Hooks, QR code de connexion, primitives de manette
  discord/   Connexion Discord (OAuth2 PKCE), vérification d'identité, Discord Activity
examples/
  buzzer/    Quiz « écran de l'hôte + téléphones », exemple complet
e2e/         Tests de bout en bout Playwright
docs/        Documentation (français)
```

## Sécurité

Signaler une vulnérabilité : voir [SECURITY.md](SECURITY.md). Principe directeur : **un client ne reçoit jamais une
information qu'il n'a pas le droit de connaître**, et le serveur ne fait confiance à rien de ce qu'il reçoit.
