/**
 * Contrat d'un transport côté client.
 *
 * Le transport ne fait que déplacer du texte : ouvrir la connexion (et la rouvrir tout
 * seul après une coupure, s'il en est capable), envoyer, recevoir. La reprise de session,
 * la validation et l'état sont gérés par `GameClient`, identiques pour tous les transports.
 */

/** Fonctions fléchées : un transport peut les passer telles quelles à ses propres évènements. */
export interface TransportHandlers {
  /** La connexion est ouverte (première fois ou après une reconnexion). */
  open: () => void;
  /** Un message texte est arrivé. */
  message: (data: string) => void;
  /** La connexion est perdue ; le transport tentera peut-être de la rouvrir. */
  close: () => void;
}

export interface ClientTransport {
  connect(handlers: TransportHandlers): void;
  send(data: string): void;
  /** Fermeture définitive (plus de reconnexion). */
  close(): void;
}
