# Renards et lapins — exemple @gamecore/sim

Un écosystème proies-prédateurs sur une grille torique de 128 × 128 : les lapins se déplacent, vieillissent et se
reproduisent (davantage au printemps), les renards les chassent, se reproduisent quand ils sont repus et meurent de
faim. Les saisons tournent, et une espèce éteinte revient par immigration. La simulation tourne dans un **Web
Worker** ; la page ne reçoit que la grille (transférée) et les statistiques.

C'est l'exemple de référence du moteur de simulation continue ([docs/simulation.md](../../docs/simulation.md)) :

| Brique                                                 | Où regarder                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Définition : état en TypedArray, commandes, systèmes   | [`src/simulation.ts`](src/simulation.ts) (`defineSimulation`)             |
| Commande système programmée (saisons)                  | `ctx.schedule("season", …)` dans [`src/simulation.ts`](src/simulation.ts) |
| Canaux : grille transférée à chaque tick, statistiques | `snapshot.channels` dans [`src/simulation.ts`](src/simulation.ts)         |
| Codec binaire et hash sans le brouillon du tick        | `codec` et `hash` dans [`src/simulation.ts`](src/simulation.ts)           |
| Web Worker (`exposeSimulation`)                        | [`src/sim.worker.ts`](src/sim.worker.ts)                                  |
| Page (`connectSimulation`, mode démo `localPort`)      | [`src/connect.ts`](src/connect.ts)                                        |
| Canvas 2D hors de React                                | [`src/render.ts`](src/render.ts)                                          |
| Pause, vitesses, sauvegarde, chargement, rejeu         | [`src/App.tsx`](src/App.tsx)                                              |
| Règles, déterminisme (10 000 ticks), performances      | [`src/simulation.test.ts`](src/simulation.test.ts)                        |
| Tests de bout en bout                                  | [`e2e/sim-playground.spec.ts`](../../e2e/sim-playground.spec.ts)          |

## Lancer

```bash
pnpm install
pnpm dev:sim-playground   # depuis la racine : Vite (5173)
```

Ouvre <http://localhost:5173>. Options dans l'adresse :

- `?seed=abc` : graine imposée (même graine et mêmes clics = même partie) ;
- `?local=1` : mode démo sans Worker, la simulation tourne dans la page (même protocole, via `localPort()`).

## Utiliser

- **Clic sur la grille** : ajoute 40 lapins (ou 40 renards, selon le choix « Un clic ajoute »).
- **Pause / ×1 / ×2 / ×4** : vitesse du cadenceur (10 ticks par seconde à ×1) ; **Pas à pas** avance d'un tick en
  pause. Le panneau compare la cadence réelle à la cadence visée et signale un retard.
- **Sauvegarder** télécharge un fichier `.gcsim` (format binaire versionné) ; **Charger une sauvegarde** le relit
  (le fichier est revalidé : un fichier quelconque est refusé).
- **Rejouer** recrée la partie depuis sa graine et le journal des commandes, puis affiche les deux hashs côte à côte :
  ils sont identiques, parce que la simulation est déterministe.

## Construire

```bash
pnpm --filter @gamecore/example-sim-playground build     # dist/ : site statique
pnpm --filter @gamecore/example-sim-playground preview   # sert dist/ sur le port 4175
```

Le build ajoute une politique de sécurité du contenu (`<meta http-equiv="Content-Security-Policy">`) : aucun script
tiers, aucune connexion sortante, Worker servi par la même origine.
