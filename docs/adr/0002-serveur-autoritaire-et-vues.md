# 0002 — Serveur autoritaire et vues projetées

- **Statut** : acceptée (2026-10-07)

## Contexte

Dans DCDS, l'état public était stocké dans Postgres, les secrets dans une table séparée, et les informations privées
distribuées ligne par ligne grâce à la sécurité au niveau des lignes (RLS) de Supabase. C'était sûr, mais chaque jeu
devait découper lui-même son état en « public », « secret » et « connaissances », et toute écriture passait par une
route HTTP avec verrouillage optimiste.

## Décision

- Le serveur de jeu fait **autorité** et garde l'**état complet** de chaque partie en mémoire.
- Un jeu déclare des **vues** : `views.public(état)` pour tout le monde, `views.private(état, joueur)` pour un joueur.
  Les clients ne reçoivent **que** ces projections, recalculées après chaque changement.
- Les actions passent par `reduce(copie, action, ctx)`, appliqué de façon **synchrone** : pas de verrou, pas de
  conflit, « premier arrivé, premier servi » garanti.
- L'état diffusé est **complet du point de vue du destinataire** (pas de différentiel) : un message perdu ne
  désynchronise jamais un client.

## Conséquences

- Écrire un jeu est plus simple : un seul état, deux fonctions de vue, et des tests qui vérifient ce que reçoit chaque
  client.
- La sécurité repose sur la justesse des vues : elles sont testées (unitaires et E2E sur les trames réseau).
- L'état vit en mémoire : un redémarrage perd les parties en cours, jusqu'à la persistance prévue avec PartyKit.
- Pour un état volumineux, l'envoi complet pourra être remplacé par des patchs, sans changer l'API des jeux.
