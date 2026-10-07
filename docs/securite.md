# Sécurité

Principes :

1. **Un client ne reçoit jamais une information qu'il n'a pas le droit de connaître.** Même en ouvrant les outils de
   développement ou en lisant le trafic réseau, un joueur ne peut pas voir la réponse avant la révélation, ni la main
   d'un autre joueur.
2. **Le serveur ne fait confiance à rien de ce qu'il reçoit** : tout est borné, limité, validé, puis vérifié par les
   règles.
3. **Sûr par défaut** : les options qui affaiblissent la sécurité doivent être activées explicitement.

## Modèle de menace

| Acteur                       | Ce qu'il peut tenter                                        | Parade                                                        |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Joueur curieux               | Lire l'état complet dans le navigateur ou le réseau         | Vues projetées par le serveur ; secrets jamais dans le bundle |
| Joueur tricheur              | Envoyer des actions hors tour, au nom d'un autre, en double | Serveur autoritaire, identité liée à la connexion, règles     |
| Joueur expulsé               | Revenir avec son ancien jeton                               | Jeton révoqué ; comptes vérifiés bannis du salon              |
| Inconnu sur Internet         | Deviner le code d'une partie privée                         | Codes cryptographiques (32⁶), limite d'échecs par IP          |
| Site malveillant             | Ouvrir une WebSocket depuis le navigateur d'un joueur       | Contrôle de l'en-tête Origin (`allowedOrigins`)               |
| Script automatisé            | Inonder le serveur, créer des milliers de salons            | Limites de taille, de débit, de salons ; fermeture            |
| Pseudo / message malveillant | XSS, usurpation visuelle (caractères invisibles, RTL)       | Nettoyage NFKC, échappement React, CSP stricte                |
| Avatar malveillant           | `javascript:`, image de pistage                             | Emojis ou HTTPS vers des hôtes autorisés uniquement           |

## Les garde-fous, dans l'ordre

### 1. Transport

- **Origine** : `secureSocketIoOptions({ allowedOrigins })` refuse toute connexion dont l'en-tête `Origin` n'est pas
  autorisé. Le CORS ne s'applique pas aux WebSockets : sans ce contrôle, n'importe quel site pourrait se connecter
  depuis le navigateur d'un visiteur.
- **Taille** : paquets Socket.io bornés à 64 Kio, puis chaque message gamecore à 16 Kio (en octets UTF-8).
- **Adresse IP** : lue sur la connexion ; `X-Forwarded-For` n'est pris en compte qu'avec `trustProxy`, à activer
  uniquement derrière un proxy de confiance.

### 2. `GameServer`

- Anti-inondation **avant** toute analyse (seau à jetons par connexion).
- Analyse JSON protégée, puis validation par `clientMessageSchema` : objets **stricts**, bornes sur chaque champ,
  version du protocole.
- Second limiteur pour les messages coûteux.
- Infractions répétées (messages illisibles, débit dépassé…) : fermeture de la connexion (code 1008).
- Entrées ratées (code inconnu, jeton invalide) comptées **par IP** : au-delà de 12 par minute, l'adresse patiente.
- Création de salons limitée par IP et au total.
- Erreurs inattendues : le client reçoit un message générique (`INTERNAL`), la pile d'appel reste dans les journaux.

### 3. `Room`

- **Identité liée à la connexion** : un message n'agit qu'au nom du membre attaché à cette connexion ; aucun champ
  « je suis X » n'est lu dans les messages.
- **Jetons de session** : 256 bits aléatoires, seule leur **empreinte SHA-256** est stockée, comparaison à durée
  constante. Révoqués par l'expulsion ou le départ. Jamais placés dans une URL.
- **Jeton d'administration** des écrans : même traitement ; un écran sans jeton n'a aucun droit.
- **Droits** : opérations de salon réservées à l'host ; actions de jeu réservées aux joueurs (et à l'host).
- **Actions** validées par le schéma du jeu ; **actions système** jamais acceptées d'un client.
- **Atomicité** : le jeu travaille sur une copie ; un refus ou une exception laisse l'état intact.
- **Vues** : chaque connexion reçoit `views.public` (+ `views.private` pour son propre joueur), jamais l'état.
- **Bannissement** des comptes vérifiés (Discord…) expulsés.

### 4. Jeu

Les règles vérifient l'acteur (`requirePlayer`, `requireHost`), la phase, et ignorent les minuteurs périmés. Les données
secrètes (réponses, paquets) ne sont importées côté navigateur qu'en `import type`.

### 5. Navigateur

- React échappe tout texte ; aucun `dangerouslySetInnerHTML` (le QR code est dessiné en SVG natif).
- Jetons en `sessionStorage` (par onglet), jamais dans l'URL ; `Referrer-Policy: no-referrer`.
- Serveur d'exemple : CSP stricte (`script-src 'self'`, `frame-ancestors 'none'`…), `X-Content-Type-Options`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy`, anti-traversée de répertoire, méthodes limitées à GET/HEAD,
  pas de _source maps_ publiques.

### 6. Chaîne d'approvisionnement

- pnpm : aucun script d'installation exécuté sans accord explicite (`allowBuilds`).
- `pnpm audit` en CI (échec sur gravité haute ou critique), Dependabot hebdomadaire, analyse CodeQL.
- Workflows GitHub en lecture seule, identifiants Git non persistés.

## Ce qui est vérifié automatiquement

| Vérification                                                                   | Où                                      |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| Taille, débit, JSON invalide, champs inconnus, version, fermeture              | `packages/server/src/server.test.ts`    |
| Force brute des codes et des jetons, création de salons                        | `packages/server/src/server.test.ts`    |
| Secrets non transmis (vues privées), jetons révoqués, droits d'host            | `packages/server/src/room.test.ts`      |
| Erreurs internes masquées                                                      | `room.test.ts`, `engine.test.ts`        |
| Pseudos et avatars (invisibles, bidi, `javascript:`, hôtes)                    | `packages/core/src/sanitize.test.ts`    |
| Origine refusée (Socket.io réel)                                               | `packages/server/src/socket-io.test.ts` |
| Aucun secret dans les trames reçues par un joueur, ni dans le JavaScript servi | `e2e/security.spec.ts`                  |
| En-têtes, traversée de répertoire, origine, pseudo HTML                        | `e2e/security.spec.ts`                  |

## Limites connues

- **NAT partagé** : derrière une même box, tous les téléphones d'une soirée ont la même IP publique. Les limites par IP
  doivent rester assez larges (voir les variables de l'exemple) ; elles freinent la force brute sans la rendre
  impossible pour un attaquant disposant de nombreuses adresses — c'est la longueur du code qui fait l'essentiel.
- **Invités** : un joueur expulsé peut revenir sous un autre pseudo avec une nouvelle connexion. Verrouiller le salon
  (`lock`) ou exiger un compte (`requireAuth` + connexion Discord, voir [discord.md](discord.md)) l'en empêche.
- **Mémoire** : les salons vivent en mémoire du processus. Un redémarrage termine les parties en cours (la persistance
  arrive avec l'adaptateur PartyKit).
- **Bluff** : rien n'empêche un joueur de montrer son écran aux autres… c'est le jeu !

## Checklist de déploiement

- [ ] HTTPS partout (`wss://`), `HSTS=1` une fois le HTTPS confirmé.
- [ ] `ALLOWED_ORIGINS` limité aux domaines du jeu.
- [ ] `TRUST_PROXY=1` **seulement** derrière un proxy qui réécrit `X-Forwarded-For`.
- [ ] Journaux du serveur conservés (erreurs internes, connexions fermées pour abus).
- [ ] Signalement privé des vulnérabilités activé sur GitHub (voir [SECURITY.md](../SECURITY.md)).
