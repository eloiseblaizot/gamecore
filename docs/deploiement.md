# Déploiement

## Quel hébergement ?

Un jeu gamecore a besoin d'un serveur qui **garde des connexions WebSocket ouvertes** et l'état des salons en mémoire.

| Hébergement                                            | Compatible | Remarques                                                                                                        |
| ------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Serveur Node (Fly.io, Railway, Render, VPS, Scaleway…) | ✅         | Transport Socket.io, un processus = tous les salons                                                              |
| Cloudflare (PartyKit / Durable Objects)                | 🔜         | Un salon = un Durable Object, persistance et mise à l'échelle                                                    |
| Vercel, Netlify (fonctions serverless)                 | ❌ seul    | Pas de connexion persistante : héberger le serveur de jeu ailleurs (l'application statique, elle, peut y rester) |

C'est pour cette raison que DCDS (sur Vercel) passait par Supabase Realtime : gamecore préfère un serveur de jeu
autoritaire, plus simple et plus sûr.

## Serveur Node (exemple : Buzzer)

```bash
pnpm install --frozen-lockfile
pnpm --filter @gamecore/example-buzzer build     # application → examples/buzzer/dist
PORT=8080 \
ALLOWED_ORIGINS=https://buzzer.games.blzt.fr \
TRUST_PROXY=1 HSTS=1 \
pnpm --filter @gamecore/example-buzzer start     # sert dist/ et les WebSockets
```

- `/healthz` renvoie `{ ok, rooms, connections }` (sonde de santé de l'hébergeur).
- `SIGTERM` : les joueurs sont prévenus (`bye: closed`) puis le processus s'arrête proprement.
- Une seule instance : les salons vivent en mémoire. Pour plusieurs instances, il faudrait router chaque salon vers
  la même instance (ou passer à PartyKit).

### Derrière un proxy (Nginx, Caddy, load balancer)

- Le proxy doit transmettre les en-têtes `Upgrade` / `Connection` (WebSockets).
- Activer `TRUST_PROXY=1` **uniquement** si le proxy réécrit `X-Forwarded-For` : sinon un client pourrait choisir son
  adresse IP et contourner les limites.
- Terminer le HTTPS au proxy, puis activer `HSTS=1`.

### Variables d'environnement

Voir le [README de l'exemple](../examples/buzzer/README.md#variables-denvironnement-du-serveur).

## Sous-domaine

Comme DCDS (`dcds.games.blzt.fr`), chaque jeu peut avoir son sous-domaine `<jeu>.games.blzt.fr` pointant vers son
serveur. `ALLOWED_ORIGINS` doit contenir exactement cette origine (`https://<jeu>.games.blzt.fr`).

## Checklist

Voir la [checklist de sécurité](securite.md#checklist-de-déploiement).
