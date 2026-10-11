# 0004 — Moteur de simulation continue (`@gamecore/sim`)

- **Statut** : acceptée (2026-10-11)

## Contexte

`defineGame` et `applyAction` (voir [ADR 0002](0002-serveur-autoritaire-et-vues.md)) copient l'état complet
(`structuredClone`) à chaque action, puis chaque connexion reçoit à nouveau sa vue complète (`sync`). C'est le bon
modèle pour un jeu à tours dont l'état pèse quelques kilo-octets : simple, atomique, sûr.

Les jeux de simulation que nous visons (ville, économie, écosystème, gestion) sont différents :

- ils avancent **seuls**, à 3–30 ticks par seconde, même quand personne n'agit ;
- leur état pèse **plusieurs méga-octets** (graphes, grilles, `TypedArray`) ;
- l'interface n'a pas besoin de tout à chaque tick : la carte change souvent, les statistiques rarement.

Copier l'état et renvoyer une vue complète à chaque tick est rédhibitoire, et les patchs JSON prévus dans la feuille
de route ne suffiraient pas (le coût est dans la copie et la sérialisation, pas seulement dans le transport).

## Décision

Ajouter un second moteur, `@gamecore/sim`, à côté de `defineGame` — sans le modifier ni le remplacer :

- **État mutable appartenant au moteur** : la simulation alloue ses `TypedArray` une fois et les modifie en place.
- **Commandes validées puis journalisées** : l'hôte envoie des commandes (schéma zod), mises en file et appliquées au
  début du tick suivant, dans l'ordre d'arrivée. Une validation pure (`validate`) refuse avant toute mutation ;
  l'application (`apply`) ne doit jamais échouer après avoir muté. Seules les commandes acceptées sont journalisées.
- **Commandes système** programmées par la simulation (`ctx.schedule`, en ticks), jamais acceptées de l'hôte.
- **Systèmes ordonnés à tick fixe** (`every` pour les systèmes lents), mesurés sans allocation.
- **Canaux de snapshot** indépendants (`grid`, `stats`…), construits et publiés seulement quand ils sont invalidés ou
  échus (`every`) ; les `TypedArray` peuvent être transférées vers la page sans copie supplémentaire.
- **Déterminisme** : même graine + mêmes réglages + même journal = même hash d'état. Le hasard passe par le RNG SFC32
  de `@gamecore/core`, sauvegardé avec la simulation ; aucune horloge dans le chemin de simulation.
- **Échec franc** : une exception dans `apply` ou dans un système met la simulation en état `corrupted` (lecture
  seule) plutôt que de continuer sur un état à moitié modifié.
- **Sauvegarde binaire versionnée** (`GCSIM`) avec migrations en chaîne, **rejeu** du journal, outils de test
  (`expectDeterministic`, `benchmark`).
- **Hôtes interchangeables** : en mémoire, cadencé par un accumulateur à pas fixe, ou dans un Web Worker via un
  protocole validé par zod des deux côtés (même protocole sur un transport en mémoire pour les tests). Le paquet ne
  dépend que de `@gamecore/core` et `zod`, et n'utilise aucune API du DOM.

Ce qu'il partage avec `@gamecore/core` : le RNG, zod, `GameError` et ses codes, la philosophie « règles pures, hôte
interchangeable ».

### Choix précisés lors de la mise en œuvre

- **Numérotation des ticks** : `sim.tick` compte les ticks terminés ; `ctx.tick` vaut le numéro du tick en cours
  d'exécution (1 pour le premier), 0 dans `create`. Le journal note le tick où la commande a été appliquée.
- **`validate` est pure** : ni hasard, ni effets. Une exception dans `validate` refuse la commande sans corrompre la
  simulation (l'état n'a pas bougé).
- **Hash** : vrai FNV-1a 64 bits calculé sur deux mots de 32 bits ; clés des objets simples triées (on hache le
  contenu), `Map` et `Set` dans l'ordre d'insertion. Le hash d'une simulation couvre aussi le tick, l'état du RNG et
  les commandes système programmées.
- **Sauvegardes non fiables** : un fichier chargé peut venir de n'importe où ; en-tête, réglages, journal et commandes
  programmées sont revalidés (zod) et la taille est bornée. La graine est conservée pour permettre le rejeu. Le hash
  de l'état rechargé est comparé à celui du fichier (fichier altéré ou codec infidèle), sauf après une migration.
- **Migrations et journal** : une sauvegarde migrée perd son journal (ses commandes suivaient des règles antérieures) ;
  les réglages sont fusionnés avec les valeurs par défaut actuelles. Les commandes système programmées sont conservées
  et doivent rester valides pour le schéma courant.
- **Réglages gelés** (`Object.freeze` en profondeur) : ils sont sauvegardés à part et le rejeu en dépend.
- **Commandes système** : une seule par clé, exécutées à échéance égale dans l'ordre de programmation ; elles ne sont
  pas journalisées (elles découlent du journal de l'hôte et de la graine).
- **Retard du cadenceur** : au-delà de `maxTicksPerFrame`, la dette de ticks est abandonnée et signalée (`onLag`)
  plutôt que rattrapée : la vitesse réelle baisse, la page ne gèle pas. L'accumulateur compte en « ms × ticks/s »
  pour rester exact avec une horloge entière.
- **Protocole** : discriminant `t` (comme le protocole de `@gamecore/core`), requêtes corrélées par `id`, un message
  `events` après chaque rafale même vide (il porte le tick et la cadence réelle). Port structurel
  `{ postMessage(message, { transfer }), onmessage }` : la forme « options » de `postMessage` est commune à `Worker`,
  `MessagePort` et au `self` d'un Worker.
- **`localPort()` clone les messages** (`structuredClone` avec transfert) : une donnée non clonable échoue en test
  comme dans un vrai Worker. Ce clonage est celui du transport, hors de la boucle de tick.
- **`expectDeterministic`** compare deux exécutions en parallèle, dont l'une passe par une sauvegarde rechargée, puis
  rejoue le journal ; il piège `Math.random`, `Date.now` et `new Date()` pendant l'exécution.
- **Ordre de livraison** : la sauvegarde (étape 7 du plan initial) a été réalisée avant le protocole Worker (étape 6),
  dont les messages `save` et `load` dépendent.

## Conséquences

- Deux moteurs à connaître ; [docs/simulation.md](../simulation.md) explique quand choisir lequel.
- Écrire une simulation demande plus de rigueur : `validate` et `apply` séparés, état mutable, pièges du déterminisme
  (ordre d'itération, flottants, horloge) documentés et vérifiés par `expectDeterministic`.
- L'état n'est jamais copié par le moteur : les canaux renvoient des vues de l'état ; ceux marqués `transfer` sont
  recopiés une fois dans le Worker avant transfert (coût documenté).
- L'hébergement d'une simulation dans une `Room` de `@gamecore/server` (mode multijoueur) est possible plus tard :
  commandes = actions validées, canaux = synchronisation différentielle. Il ne fait pas partie de cette itération.
