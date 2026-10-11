# Feuille de route

Chaque itération se termine par des commits au format Conventional Commits, poussés sur `main`, avec leurs tests
(dont E2E pour les parcours joueurs) et leur documentation.

## ✅ Itération 1 — Fondations (octobre 2026)

- Monorepo pnpm, TypeScript strict, ESLint typé, Prettier, commitlint + husky, CI GitHub (qualité, E2E, audit),
  CodeQL, Dependabot.
- `@gamecore/core` : `defineGame`, moteur pur, hasard déterministe, codes et jetons, protocole zod, nettoyage.
- `@gamecore/server` : salons à code, host, spectateurs, écrans de l'hôte, reprise de session, minuteurs, vues par
  destinataire, chaîne de sécurité, modules manettes et chat, transport Socket.io, outils de test.
- `@gamecore/client` : client de jeu, reprise de session, transports Socket.io et local.
- `@gamecore/react` : hooks, QR code, bouton de manette, joystick, écran allumé, vibrations.
- Jeu d'exemple « Buzzer ! » et tests de bout en bout Playwright.

## ✅ Itération 2 — Discord (octobre 2026)

- `@gamecore/discord` : connexion web OAuth2 avec PKCE et `state`, route d'échange du code, vérification d'identité
  pour `GameServer`, Discord Activity (salon dérivé de l'instance, proxy `/.proxy/`).
- Serveur : création de salon authentifiée, création de salon à la volée contrôlée (`createOnJoin`).
- Buzzer : bouton « Se connecter avec Discord », mode Activity, configuration publique, CSP adaptée.
- E2E face à un faux Discord local. Voir [discord.md](discord.md).

## ✅ Itération 3 — Bots et mode démo (octobre 2026)

- Stratégie `bots` dans `defineGame`, bots membres-joueurs gérés par le serveur (ajout par l'host, délai humain,
  hasard séparé, coups validés comme ceux des humains).
- `createDemoRoom` : partie complète dans la page (transport local), écran + joueur + bots.
- Buzzer : bots qui « connaissent » la réponse 6 fois sur 10, page `/demo` (écran et téléphone côte à côte, aucune
  connexion réseau), bouton « Ajouter un bot » en ligne, banque de questions distincte pour la démo.

## ✅ Itération 4 — Son synthétisé (octobre 2026)

- `@gamecore/audio` : instruments Web Audio, 28 bruitages génériques, 5 ambiances, moteur configurable (sons propres
  au jeu, réglages mémorisés, autoplay respecté, atténuation), liaisons React, faux contexte audio pour les tests.
- Buzzer : musique et bruitages sur l'écran de l'hôte, sons discrets sur les téléphones, bouton 🔊. Voir
  [audio.md](audio.md).

## ✅ Itération 5 — Vidéo et audio LiveKit (octobre 2026)

- Message générique `module` et identifiant aléatoire de salon pour les modules.
- `@gamecore/livekit` : jetons délivrés par le salon selon le rôle et une politique du jeu, fournisseur React, tuiles
  par membre, détection de parole (atténuation de la musique), webcam locale pour la démo.
- Buzzer : réglages caméras / micros, webcams sur l'écran et les téléphones, CSP limitée au serveur LiveKit.
- E2E avec la fausse caméra de Chromium, et avec un vrai serveur LiveKit en CI. Voir [livekit.md](livekit.md).

## ✅ Itération 6 — Rich Presence Discord (octobre 2026)

- `@gamecore/discord` : présence (détails, état, temps, groupe, images) au format Discord, mises à jour regroupées
  selon le rythme imposé par Discord, hook `useDiscordPresence`, invitations depuis l'Activity.
- Buzzer : présence calculée par une fonction pure (information publique uniquement), bouton « Inviter des amis ».
  Voir [discord.md](discord.md#rich-presence-et-invitations-activity).

## ✅ Itération 7 — Simulation continue (octobre 2026)

- Second moteur `@gamecore/sim`, à côté de `defineGame` (voir l'[ADR 0004](adr/0004-moteur-de-simulation-continue.md)) :
  `defineSimulation`, état mutable à tick fixe, commandes validées (`validate` pur) puis journalisées, commandes
  système programmées en ticks, systèmes ordonnés (`every`), canaux de snapshot publiés quand ils changent, échec
  franc (`corrupted`), profilage sans allocation.
- Cadenceur à pas fixe (`createRunner`) avec vitesse, pause, pas à pas et signalement du retard ; protocole Worker
  validé par zod des deux côtés (`exposeSimulation`, `connectSimulation`, `localPort`).
- Sauvegarde binaire versionnée GCSIM (fichiers revalidés, migrations en chaîne), compaction du journal, rejeu, et
  outils de test : `expectDeterministic`, `benchmark`, fausses horloges.
- Exemple « Renards et lapins » (`examples/sim-playground`) : simulation dans un Web Worker, canvas, sauvegarde,
  chargement et rejeu à hash égal ; E2E Playwright. Voir [simulation.md](simulation.md).

## 🔜 Prochaines itérations

### Hébergement d'une simulation dans une `Room` (mode multijoueur)

- Adaptateur qui fait tourner une simulation `@gamecore/sim` dans une `Room` de `@gamecore/server` : les commandes
  deviennent des actions validées (droits par membre, limites de débit), les canaux une synchronisation
  différentielle vers l'écran et les téléphones, le cadenceur est piloté par le serveur.
- Vues par destinataire pour les canaux (ce que voit chaque joueur), reprise de session, sauvegarde du salon.

### PartyKit (Cloudflare)

- Adaptateur serveur : un salon = un Durable Object (`partyserver`), code du salon = identifiant de la _party_.
- Persistance de l'état du salon (sérialisation de `Room`) pour survivre à l'hibernation et aux redéploiements ;
  minuteurs du jeu via les alarmes des Durable Objects.
- Transport client `partysocket`. Tests d'intégration avec Miniflare, E2E du Buzzer sur PartyKit.

### Discord (suite)

- Vérification de l'appartenance à l'instance d'Activity (jeton de bot).

### Reprises de DCDS

- **Portage de DCDS** sur gamecore.

### Outillage

- Publication des paquets (registre et portée npm à choisir) et modèle `create-gamecore` pour démarrer un jeu.
- Messages d'état différentiels (patchs JSON) si un jeu `defineGame` a un état volumineux (les jeux qui avancent seuls
  utilisent `@gamecore/sim`).
- Allègement du bundle navigateur (zod mini côté client).
