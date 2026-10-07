# Buzzer ! — jeu d'exemple gamecore

Quiz façon plateau TV : **l'écran de l'hôte** (télé, PC partagé, stream) affiche les questions, chaque joueur répond
sur **son téléphone** devenu buzzer. Plus on répond vite, plus on marque de points.

Il sert de démonstration complète du moteur :

| Fonctionnalité                      | Où regarder                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Règles en fonctions pures, testées  | [`src/game.ts`](src/game.ts), [`src/game.test.ts`](src/game.test.ts)                                 |
| Salon à code + QR code              | [`src/screens/HostScreen.tsx`](src/screens/HostScreen.tsx) (`JoinQrCode`)                            |
| Écran de l'hôte (vue publique)      | [`src/screens/HostScreen.tsx`](src/screens/HostScreen.tsx)                                           |
| Téléphone-manette (vue privée)      | [`src/screens/Phone.tsx`](src/screens/Phone.tsx) (`ControllerButton`, `useWakeLock`)                 |
| Module manettes (réactions → écran) | [`src/reactions.ts`](src/reactions.ts), `controllerModule` dans [`server/index.ts`](server/index.ts) |
| Chrono calé sur l'heure du serveur  | [`src/ui/Countdown.tsx`](src/ui/Countdown.tsx) (`useCountdown`)                                      |
| Reprise après rechargement          | [`src/useEnterRoom.ts`](src/useEnterRoom.ts)                                                         |
| Serveur Node durci (CSP, origines…) | [`server/index.ts`](server/index.ts), [`server/http.ts`](server/http.ts)                             |

## Lancer

```bash
pnpm install
pnpm dev:buzzer          # depuis la racine : serveur de jeu (3001) + Vite (5173)
```

Ouvre <http://localhost:5173>, clique sur « Créer une partie », puis rejoins depuis un autre onglet via le QR code
ou le code affiché.

Pour jouer avec de vrais téléphones sur le même Wi-Fi, expose Vite sur le réseau et autorise son origine :

```bash
ALLOWED_ORIGINS=http://192.168.1.42:5173 pnpm dev:buzzer --host   # remplace par l'adresse IP de l'ordinateur
```

puis ouvre `http://192.168.1.42:5173` sur l'ordinateur qui sert d'écran : le QR code pointera vers cette adresse.

En mode production (build puis un seul serveur qui sert l'application et les WebSockets) :

```bash
pnpm --filter @gamecore/example-buzzer build
pnpm --filter @gamecore/example-buzzer start   # http://localhost:3001
```

## Variables d'environnement du serveur

| Variable          | Rôle                                                                   | Défaut                                        |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| `PORT`            | Port d'écoute                                                          | `3001`                                        |
| `ALLOWED_ORIGINS` | Origines autorisées à ouvrir une WebSocket (séparées par des virgules) | `http://localhost:PORT,http://localhost:5173` |
| `TRUST_PROXY`     | `1` derrière un proxy de confiance (lecture de `X-Forwarded-For`)      | —                                             |
| `HSTS`            | `1` pour envoyer `Strict-Transport-Security` (HTTPS uniquement)        | —                                             |

## Secrets

Les questions et leurs réponses ([`src/questions.ts`](src/questions.ts)) ne sont lues que par le serveur : le code du
navigateur importe le jeu en `import type` uniquement. Un test de bout en bout vérifie que le JavaScript envoyé aux
joueurs ne contient aucune réponse, et qu'aucune réponse ne transite par le réseau avant la révélation.
