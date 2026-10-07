# Tests

Trois niveaux, tous lancés en CI à chaque poussée.

| Niveau       | Outil      | Commande        | Ce qui est testé                                                                                 |
| ------------ | ---------- | --------------- | ------------------------------------------------------------------------------------------------ |
| Unitaires    | Vitest     | `pnpm test`     | Moteur pur, hasard, codes, nettoyage, protocole, règles des jeux                                 |
| Intégration  | Vitest     | `pnpm test`     | Serveur complet sans réseau, client ↔ serveur (local et Socket.io réel), hooks React (happy-dom) |
| Bout en bout | Playwright | `pnpm test:e2e` | Le jeu d'exemple servi comme en production, joué par de vrais navigateurs                        |

`pnpm test:coverage` mesure la couverture des paquets ; la CI échoue sous **80 %** des instructions et des lignes,
**75 %** des fonctions, **70 %** des branches.

## Tests unitaires et d'intégration

- Fichiers `*.test.ts(x)` à côté du code, dans `packages/*/src` et `examples/*/src`.
- Les paquets `@gamecore/*` sont lus depuis leurs **sources** (alias dans [`vitest.config.ts`](../vitest.config.ts)) :
  aucun build n'est nécessaire.
- Les composants React se testent avec `// @vitest-environment happy-dom` en tête de fichier.
- Les minuteurs (chronos, délais de grâce, fermeture des salons vides) se testent avec `vi.useFakeTimers()` et
  `vi.advanceTimersByTimeAsync()` : le runtime n'appelle jamais `setTimeout` en direct.
- Un jeu se teste avec le **vrai serveur** grâce à `@gamecore/server/testing` (voir
  [Créer un jeu](creer-un-jeu.md#2-tester-les-règles)).

## Tests de bout en bout

[`playwright.config.ts`](../playwright.config.ts) construit le jeu d'exemple et le sert comme en production (un seul
serveur Node sur le port 4173, application + WebSockets), puis :

- un **écran d'hôte** dans un contexte « PC » (1280×800) ;
- des **joueurs** dans des contextes « téléphone » (`Pixel 7` : écran mobile, tactile, agent utilisateur Android),
  chacun isolé (son propre `sessionStorage`, donc sa propre identité).

```bash
pnpm exec playwright install chromium   # une seule fois
pnpm test:e2e                           # tous les parcours
pnpm test:e2e --ui                      # mode interactif
pnpm test:e2e e2e/security.spec.ts      # un fichier
```

En cas d'échec, la trace (`test-results/…/trace.zip`, à ouvrir avec `pnpm exec playwright show-trace`) rejoue le test
image par image ; en CI, elle est attachée à l'exécution.

### Parcours couverts

- Partie complète à trois, du salon au podium, puis revanche.
- Fin du chrono sans réponse de tout le monde.
- Rechargement d'un téléphone en pleine partie (place et points conservés), rechargement de l'écran (droits d'host).
- Expulsion (le joueur est informé, son jeton ne fonctionne plus).
- Lancement depuis le téléphone du premier joueur ; code inconnu ou mal formé ; réactions vers l'écran ; jeu au clavier.

### Sécurité vérifiée de bout en bout

- Les trames WebSocket reçues par un joueur ne contiennent ni la bonne réponse, ni la réponse d'un autre joueur avant
  la révélation (les trames Socket.io sont décodées et analysées).
- Le JavaScript servi aux navigateurs ne contient ni les questions ni les réponses.
- En-têtes de sécurité, traversée de répertoire, origine étrangère refusée, pseudo HTML affiché comme du texte.

### Limites par IP

Tous les navigateurs de test partagent `127.0.0.1` : la configuration Playwright relève les limites par adresse IP
(`ROOMS_PER_MINUTE_PER_IP`, `FAILED_JOINS_PER_MINUTE`) du serveur de test.
