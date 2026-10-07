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

## 🔜 Prochaines itérations

### PartyKit (Cloudflare)

- Adaptateur serveur : un salon = un Durable Object (`partyserver`), code du salon = identifiant de la _party_.
- Persistance de l'état du salon (sérialisation de `Room`) pour survivre à l'hibernation et aux redéploiements ;
  minuteurs du jeu via les alarmes des Durable Objects.
- Transport client `partysocket`. Tests d'intégration avec Miniflare, E2E du Buzzer sur PartyKit.

### Discord

- **Connexion Discord** (OAuth2 _authorization code_ + PKCE, portée `identify`) : identité vérifiée côté serveur
  (`authenticate`), bannissement durable, pseudo et avatar Discord.
- **Discord Activity** (Embedded App SDK) : le jeu se lance dans un salon vocal ; l'instance de l'Activity devient le
  salon gamecore (tout le salon vocal joue ensemble, sans code) ; échange du code d'autorisation côté serveur ;
  `frame-ancestors` et _URL mappings_ adaptés.
- Création de salon authentifiée (`credential` dans `create`).

### Reprises de DCDS

- **Bots et mode démo** : bots pilotés par une fonction pure par jeu, partie complète dans le navigateur (transport
  local), panneau de démo.
- **Son** : moteur Web Audio synthétisé (aucun fichier, libre de droits pour les streams), ambiances, bruitages,
  atténuation quand quelqu'un parle, réglages mémorisés.
- **Vidéo et audio** (LiveKit) : jetons délivrés par le serveur aux seuls membres, publication selon le rôle et les
  réglages de l'host.
- **Portage de DCDS** sur gamecore.

### Outillage

- Publication des paquets (registre et portée npm à choisir) et modèle `create-gamecore` pour démarrer un jeu.
- Messages d'état différentiels (patchs JSON) si un jeu a un état volumineux.
- Allègement du bundle navigateur (zod mini côté client).
