# Modules

gamecore est découpé en briques qu'un jeu active selon ses besoins. Certaines sont toujours là (salon, reprise de
session), d'autres s'ajoutent au serveur (`modules: [...]`) ou côté interface.

| Module                        | Activation                                                 | Rôle                                                         |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Salon à code                  | toujours                                                   | Code, host, joueurs/spectateurs, réglages, verrou, expulsion |
| Écran de l'hôte               | `client.create("screen")` / `client.watch(code)`           | Écran partagé qui affiche la vue publique                    |
| Manettes (actions)            | toujours                                                   | `client.act(action)` depuis un téléphone                     |
| Manettes (entrées temps réel) | `controllerModule()`                                       | Joystick, boutons maintenus… relayés aux écrans              |
| Chat                          | `chatModule()`                                             | Canaux, audiences secrètes, historique, anti-spam            |
| Transport Socket.io           | `@gamecore/server/socket-io`, `@gamecore/client/socket-io` | Serveur Node classique                                       |
| Transport local               | `@gamecore/client/local`                                   | Serveur dans la page : mode démo, tests                      |
| Transport PartyKit            | 🔜                                                         | Cloudflare Durable Objects                                   |
| Discord (connexion, Activity) | `@gamecore/discord` — voir [discord.md](discord.md)        | Identité vérifiée, jeu lancé dans un salon vocal Discord     |
| Bots, son, vidéo              | 🔜                                                         | Repris de DCDS                                               |

## Salon à code

Intégré au serveur. Codes de 6 caractères tirés avec un générateur cryptographique, dans un alphabet sans
caractères ambigus (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` : ni 0/O, ni 1/I). Opérations (`client.lobby.*`) :

| Opération                      | Qui      | Quand                                        |
| ------------------------------ | -------- | -------------------------------------------- |
| `start()`                      | host     | salon d'attente, ou fin de partie (revanche) |
| `settings(patch)`              | host     | hors partie                                  |
| `kick(memberId)`               | host     | toujours                                     |
| `promote(memberId)`            | host     | toujours                                     |
| `lock(true / false)`           | host     | toujours                                     |
| `end()`                        | host     | pendant ou après une partie                  |
| `role("player" / "spectator")` | soi-même | hors partie                                  |

Un joueur qui arrive alors que la partie a commencé, ou que toutes les places sont prises, devient spectateur
(`allowSpectators: false` pour l'interdire).

## Écran de l'hôte

Un écran est une connexion **sans siège** : il n'apparaît pas dans la liste des membres et ne reçoit que la vue
publique. Deux façons de brancher un écran :

- `client.create("screen")` : crée le salon. Le serveur renvoie un **jeton d'administration** (mémorisé par le client)
  qui donne à cet écran les droits d'host, y compris après un rechargement de page.
- `client.watch(code)` : écran « spectateur » sans droits (une seconde télé, un overlay de stream). Interdit si le
  serveur est configuré avec `allowAnonymousScreens: false`.

Quand le salon est créé par un écran, le premier joueur devient aussi host : il peut lancer la partie depuis son
téléphone (pratique quand l'écran est une télé sans clavier). Au plus `limits.maxScreens` (4) écrans par salon.

## Manettes

### Actions (cas le plus courant)

Un téléphone envoie une action au jeu : `client.act({ type: "answer", choice: 2 })`. Fiable, validée par les règles,
diffusée à tous via l'état. Côté interface, `ControllerButton` réagit dès l'appui du doigt, vibre, et fonctionne au
clavier.

### Entrées temps réel : `controllerModule`

Pour les jeux où l'écran fait tourner la simulation (course, plateforme), les entrées (joystick, gyroscope) sont
**relayées** aux écrans sans passer par l'état du jeu :

```ts
// serveur
controllerModule({
  schema: z.strictObject({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }),
  inputsPerSecond: 30, // au-delà, les entrées sont ignorées sans erreur
  to: "screens", // ou "screens-and-host"
  from: "players", // ou "members" (spectateurs compris)
});

// téléphone
<Joystick onMove={(v) => client.sendInput(v)} rateHz={30} />;

// écran
useControllerInput((from, data) => moveCar(from, data as { x: number; y: number }));
```

Toujours fournir un `schema` : sans lui, n'importe quel JSON (dans la limite de taille) serait relayé à l'écran.

## Chat : `chatModule`

```ts
chatModule({
  maxLength: 280, // en caractères perçus
  history: 50, // renvoyé aux connexions qui arrivent
  messagesPer10s: 5, // anti-spam par membre
  spectatorsCanWrite: true,
  // Canaux et destinataires : « all », une liste de membres, ou null (refusé).
  audience: (channel, sender, ctx) => (channel === "all" ? "all" : null),
});
```

Les messages sont nettoyés (caractères invisibles, retours à la ligne) et leurs destinataires **figés à l'envoi** :
l'historique renvoyé à une connexion qui arrive est filtré selon cette audience. Exemple d'un canal secret (le chat des
participants de DCDS, que le décideur ne voit pas) dans la documentation de [`chat.ts`](../packages/server/src/modules/chat.ts).
Côté interface : `const { messages, send } = useChat()`.

## Transports

| Transport | Serveur                                                    | Client                       |
| --------- | ---------------------------------------------------------- | ---------------------------- |
| Socket.io | `attachSocketIo(io, gameServer)` + `secureSocketIoOptions` | `socketIoTransport(url?)`    |
| Local     | `new GameServer({ game })` dans la page                    | `localTransport(gameServer)` |
| PartyKit  | 🔜                                                         | 🔜                           |

Un transport ne fait que transporter du texte : `GameServer.connect`, `receive`, `disconnect` côté serveur ;
l'interface `ClientTransport` (`connect`, `send`, `close`) côté client. Toute la sécurité est commune.

## Écrire un module serveur

```ts
import { GameError } from "@gamecore/core";
import type { ServerModule } from "@gamecore/server";

export function votesModule(): ServerModule {
  return {
    name: "votes",
    handles: ["input"], // types de messages client pris en charge
    handle(ctx, sender, message) {
      if (message.t !== "input" || !sender.member) throw new GameError("FORBIDDEN", "…");
      const votes = ctx.state(() => new Map<string, unknown>()); // état propre au salon
      votes.set(sender.member.id, message.data);
      ctx.send((r) => r.viewer.kind === "screen", { t: "event", name: "votes", data: votes.size });
    },
    onAttach(ctx, recipient) {
      /* envoyer un historique à une connexion qui arrive */
    },
    onMemberLeave(ctx, memberId) {
      ctx.state(() => new Map<string, unknown>()).delete(memberId);
    },
  };
}
```

Un module ne voit jamais l'état du jeu en écriture : il lit (`ctx.gameState()`, `ctx.members()`…) et envoie des
messages. Les règles restent dans le jeu.
