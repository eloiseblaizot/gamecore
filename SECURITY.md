# Politique de sécurité

## Signaler une vulnérabilité

Merci de **ne pas ouvrir d'issue publique** pour une faille de sécurité. Utilise plutôt le signalement privé de
GitHub : onglet **Security** du dépôt → **Report a vulnerability**. Décris le problème, son impact et, si possible, un
moyen de le reproduire.

Nous accusons réception sous 72 heures et tenons l'auteur du signalement informé de la correction.

## Versions prises en charge

Le projet est en développement actif (versions `0.x`) : seule la dernière version de la branche `main` reçoit des
correctifs.

## Ce qui est dans le périmètre

- Fuite d'une information secrète d'une partie (réponse, main d'un autre joueur…) vers un client non autorisé.
- Usurpation d'une place dans un salon, contournement des droits d'host, reprise de session sans jeton valide.
- Contournement des limites (taille, débit, tentatives d'entrée) ou déni de service à faible coût.
- Injection (XSS via un pseudo ou un message, traversée de répertoire…).

Le modèle de menace et les garde-fous sont détaillés dans [docs/securite.md](docs/securite.md).
