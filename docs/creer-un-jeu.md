# Créer un jeu avec gamecore

Ce guide construit un jeu de A à Z. Le jeu d'exemple [`examples/buzzer`](../examples/buzzer) suit exactement ces
étapes : n'hésite pas à t'en inspirer (ou à le copier pour démarrer).

## 1. Les règles : `defineGame`

Un jeu est un objet décrit par `defineGame` (paquet `@gamecore/core`). Toutes ses fonctions sont **pures** : elles
reçoivent tout ce dont elles ont besoin dans `ctx` et ne font aucune entrée/sortie.

```ts
import { defineGame } from "@gamecore/core";
import { z } from "zod";

export const monJeu = defineGame({
  id: "mon-jeu", // minuscules, chiffres, tirets
  name: "Mon jeu",
  minPlayers: 2,
  maxPlayers: 8,

  // Réglages modifiables par l'host dans le salon d'attente (validés par le schéma).
  settings: {
    schema: z.strictObject({ manches: z.number().int().min(1).max(10) }),
    defaults: { manches: 3 },
  },

  // Ce que les CLIENTS peuvent envoyer. Tout le reste est rejeté avant d'arriver à `reduce`.
  actions: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("jouer"), carte: z.number().int().min(0).max(51) }),
    z.strictObject({ type: z.literal("suivant") }),
  ]),

  // Actions SYSTÈME, programmées par le jeu lui-même (fin de chrono…). Jamais acceptées d'un client.
  systemActions: z.strictObject({ type: z.literal("chrono"), manche: z.number().int() }),

  // État initial au lancement. Déclare `setup` AVANT `reduce` : TypeScript en déduit le type de l'état.
  setup(ctx): Etat {
    ctx.schedule("chrono", 30_000, { type: "chrono", manche: 1 });
    return {
      manche: 1,
      paquet: ctx.random.shuffle(PAQUET), // hasard déterministe du salon
      mains: {},
      scores: Object.fromEntries(ctx.players.map((p) => [p.id, 0])),
    };
  },

  // Applique une action sur une COPIE de l'état (on peut la modifier directement).
  reduce(etat, action, ctx) {
    switch (action.type) {
      case "jouer": {
        const joueur = ctx.requirePlayer(); // refuse les spectateurs et les écrans
        if (!etat.mains[joueur]?.includes(action.carte)) ctx.reject("Tu n'as pas cette carte.");
        // … appliquer la règle …
        ctx.emit("carte-jouee", { par: joueur }, "screens"); // animation sur l'écran de l'hôte
        return;
      }
      case "suivant":
        ctx.requireHost();
        // …
        return;
      case "chrono":
        if (ctx.actor.kind !== "system" || action.manche !== etat.manche) return; // chrono périmé
        // …
        return;
    }
  },

  // Ce que les clients reçoivent. JAMAIS l'état complet.
  views: {
    public: (etat) => ({ manche: etat.manche, scores: etat.scores }), // écran, spectateurs, tout le monde
    private: (etat, joueur) => ({ main: etat.mains[joueur] ?? [] }), // ce joueur seulement
  },

  isOver: (etat) => etat.manche > 3, // le salon passe à « finished » (podium, revanche…)

  // Un joueur quitte DÉFINITIVEMENT la partie (pas une simple déconnexion).
  onPlayerLeave(etat, joueur, ctx) {
    delete etat.mains[joueur];
  },
});
```

### Le contexte `ctx`

| Membre                          | Rôle                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `ctx.players`                   | Joueurs de la partie (`id`, `name`, `avatar`, `connected`)                                    |
| `ctx.settings`                  | Réglages validés                                                                              |
| `ctx.now`                       | Horodatage serveur de l'action                                                                |
| `ctx.random`                    | Hasard déterministe : `next()`, `int(min, max)`, `pick(liste)`, `shuffle(liste)`, `chance(p)` |
| `ctx.actor`                     | Qui agit : `player`, `spectator`, `screen` (avec `isHost`) ou `system`                        |
| `ctx.reject(message)`           | Refuse l'action (message affiché au joueur), l'état reste intact                              |
| `ctx.requirePlayer()`           | Identifiant du joueur qui agit, ou refus                                                      |
| `ctx.requireHost()`             | Refus si l'action ne vient ni de l'host ni du système                                         |
| `ctx.schedule(clé, ms, action)` | Programme une action système (une par clé : reprogrammer remplace)                            |
| `ctx.cancel(clé)`               | Annule une action programmée                                                                  |
| `ctx.emit(nom, données, à)`     | Évènement éphémère vers `"all"`, `"screens"`, `"players"` ou `{ only: [ids] }`                |

### Les règles d'or

1. **Aucun secret dans `views.public`.** Ce qui est privé passe par `views.private`.
2. **Pas de `Math.random()` ni de `Date.now()`** : utilise `ctx.random` et `ctx.now` (parties rejouables, tests
   déterministes).
3. **Toujours vérifier qui agit et quand** (`requirePlayer`, `requireHost`, phase en cours) : le schéma ne valide que
   la forme d'une action, pas son droit d'exister.
4. **Les actions système portent un repère** (numéro de manche…) : un minuteur d'une manche précédente doit être
   ignoré.
5. **Les données secrètes du jeu ne vont jamais dans le navigateur** : importe le jeu en `import type` côté client.

## 2. Tester les règles

Les outils de `@gamecore/server/testing` font tourner le VRAI serveur, sans réseau :

```ts
import { createTestServer } from "@gamecore/server/testing";
import { beforeEach, expect, it, vi } from "vitest";
import { monJeu } from "./game.js";

beforeEach(() => vi.useFakeTimers()); // les minuteurs du jeu se pilotent avec vi.advanceTimersByTimeAsync

it("ne montre pas la main des autres", async () => {
  const { client } = createTestServer({ game: monJeu });
  const ecran = client();
  const { code } = await ecran.create("screen");
  const alice = client();
  const bob = client();
  await alice.join(code, "Alice");
  await bob.join(code, "Bob");
  await ecran.lobby({ op: "start" });

  expect(alice.sync().game?.private).toBeDefined();
  expect(JSON.stringify(bob.conn.received)).not.toContain(/* une carte d'Alice */ "…");
  await expect(bob.act({ type: "suivant" })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
```

Chaque client de test garde tous les messages reçus (`conn.received`), son dernier état (`sync()`), et offre
`create`, `join`, `resume`, `watch`, `lobby`, `act`, `request`, `expectError`, `disconnect`. Voir
[`examples/buzzer/src/game.test.ts`](../examples/buzzer/src/game.test.ts).

## 3. Le serveur

```ts
import { GameServer, controllerModule, chatModule } from "@gamecore/server";
import { attachSocketIo, secureSocketIoOptions } from "@gamecore/server/socket-io";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { monJeu } from "./src/game.js";

const http = createServer();
const io = new Server(http, secureSocketIoOptions({ allowedOrigins: ["https://monjeu.fr"] }));
attachSocketIo(io, new GameServer({ game: monJeu, modules: [chatModule()] }), { trustProxy: true });
http.listen(3000);
```

Le serveur complet de l'exemple (fichiers statiques, en-têtes de sécurité, arrêt propre) est dans
[`examples/buzzer/server`](../examples/buzzer/server). Options utiles de `GameServer` : `limits`, `lobbyGraceMs`,
`emptyRoomTtlMs`, `allowSpectators`, `allowAnonymousScreens`, `authenticate`, `requireAuth`. Voir
[sécurité](securite.md) et [modules](modules.md).

## 4. L'interface

```tsx
import { GameClient } from "@gamecore/client";
import { socketIoTransport } from "@gamecore/client/socket-io";
import { GameProvider, useGame, useGameClient, useRoom } from "@gamecore/react";
import type { MonJeu } from "./game.js"; // ⚠️ import type uniquement

const client = new GameClient<MonJeu>({ transport: socketIoTransport() });

function Main() {
  const client = useGameClient<MonJeu>();
  const game = useGame<MonJeu>(); // { public, private? } typés d'après le jeu
  return (
    <ul>
      {game?.private?.main.map((carte) => (
        <li key={carte}>
          <button onClick={() => client.act({ type: "jouer", carte })}>{carte}</button>
        </li>
      ))}
    </ul>
  );
}

createRoot(root).render(
  <GameProvider client={client}>
    <Main />
  </GameProvider>,
);
```

### Écran de l'hôte et téléphones

| Besoin                              | Outil                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| Créer la partie sur l'écran partagé | `client.create("screen")` (le jeton d'admin est mémorisé automatiquement)           |
| Afficher le QR code de connexion    | `<JoinQrCode url={joinUrl(code)} />`                                                |
| Rejoindre depuis un téléphone       | `client.join(code, { name, avatar })`                                               |
| Revenir après un rechargement       | `client.resume(code)` (renvoie `null` s'il faut rejoindre à nouveau)                |
| Gros boutons réactifs, vibrations   | `<ControllerButton onPress={…} />`, `vibrate(30)`                                   |
| Joystick                            | `<Joystick onMove={(v) => client.sendInput(v)} />` + module `controller`            |
| Garder l'écran du téléphone allumé  | `useWakeLock()`                                                                     |
| Compte à rebours juste              | `useCountdown(deadline)` (heure du serveur)                                         |
| Animations déclenchées par le jeu   | `useGameEvent("carte-jouee", (data) => …)`                                          |
| Entrées des manettes (côté écran)   | `useControllerInput((de, data) => …)`                                               |
| Opérations de salon (host)          | `client.lobby.start()`, `.settings()`, `.kick()`, `.promote()`, `.lock()`, `.end()` |

La logique d'entrée dans un salon de l'exemple ([`useEnterRoom.ts`](../examples/buzzer/src/useEnterRoom.ts)) et ses
deux interfaces ([`HostScreen.tsx`](../examples/buzzer/src/screens/HostScreen.tsx),
[`Phone.tsx`](../examples/buzzer/src/screens/Phone.tsx)) sont de bons points de départ.

## 5. Les tests de bout en bout

Ajoute un fichier dans [`e2e/`](../e2e) (ou dans le dépôt de ton jeu) : Playwright lance le serveur de production et
pilote un écran sur « PC » et des téléphones émulés. Les aides de [`e2e/helpers.ts`](../e2e/helpers.ts) montrent
comment ouvrir un écran, faire rejoindre un téléphone et répondre. Pense aux parcours essentiels : partie complète,
rechargement en pleine partie, expulsion, et **un test qui vérifie qu'aucune trame reçue par un joueur ne contient un
secret** (voir [`e2e/security.spec.ts`](../e2e/security.spec.ts)).

## 6. Checklist avant de publier un jeu

- [ ] Aucune donnée secrète dans `views.public`, aucun import du jeu (hors `import type`) côté navigateur.
- [ ] Chaque action vérifie l'acteur et la phase ; chaque action système vérifie qu'elle n'est pas périmée.
- [ ] Les réglages ont des bornes raisonnables (durées, nombres).
- [ ] Tests des règles (vues privées comprises) et parcours E2E principaux.
- [ ] `ALLOWED_ORIGINS` configuré, HTTPS en production, `TRUST_PROXY` seulement derrière un proxy de confiance.
