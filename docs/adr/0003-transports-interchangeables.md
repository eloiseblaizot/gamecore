# 0003 — Runtime indépendant du transport

- **Statut** : acceptée (2026-10-07)

## Contexte

Les jeux visés n'ont pas tous les mêmes contraintes d'hébergement : serveur Node classique (Socket.io), Cloudflare
(PartyKit), application Discord (Activity dans une iframe), mode démo hors ligne dans le navigateur. La sécurité, elle,
doit être identique partout.

## Décision

- Le runtime (`GameServer`, `Room`, modules) ne connaît qu'une interface minimale : `connect(connexion)`,
  `receive(id, texte)`, `disconnect(id)`, et une connexion qui sait `send(texte)` et `close()`.
- Il n'utilise que des API standard (Web Crypto, `TextEncoder`, `structuredClone`), une horloge et un journal
  injectables : il tourne sous Node, Cloudflare Workers et dans un navigateur.
- Chaque transport est un adaptateur de quelques dizaines de lignes, dans un sous-chemin dédié. Toutes les
  vérifications (taille, débit, schémas, droits) sont faites par le runtime, jamais par l'adaptateur.
- Côté client, même principe : `ClientTransport` (`connect`, `send`, `close`) ; la reprise de session et l'état sont
  dans `GameClient`.

## Conséquences

- Ajouter PartyKit ou Discord ne touche ni aux jeux ni aux règles de sécurité.
- Le mode démo exécute exactement le serveur de production (transport local).
- Les tests du runtime n'ont pas besoin de réseau ; seuls les adaptateurs ont des tests d'intégration réseau.
