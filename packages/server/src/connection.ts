/**
 * Contrat entre le runtime et un transport (Socket.io, PartyKit, connexion locale…).
 *
 * Un transport n'a que trois choses à faire : signaler une nouvelle connexion
 * (`GameServer.connect`), transmettre chaque message texte reçu (`GameServer.receive`) et
 * signaler la déconnexion (`GameServer.disconnect`). Tout le reste (validation, salons,
 * sécurité) est commun à tous les transports.
 */

export interface ConnectionMeta {
  /** Adresse IP du client (pour limiter les tentatives par adresse), si connue. */
  ip: string | null;
  /** En-tête Origin de la requête de connexion, si connu. */
  origin: string | null;
  userAgent: string | null;
}

export interface Connection {
  /** Identifiant unique de la connexion, attribué par le transport. */
  readonly id: string;
  readonly meta: ConnectionMeta;
  /** Envoie un message texte (JSON) au client. Ne doit pas lever d'exception. */
  send(data: string): void;
  /** Ferme la connexion (code WebSocket 1008 = violation de politique). */
  close(code?: number, reason?: string): void;
}

/** Identité vérifiée par un fournisseur (Discord…), voir `GameServerOptions.authenticate`. */
export interface VerifiedIdentity {
  provider: string;
  /** Identifiant stable chez le fournisseur. */
  externalId: string;
  name: string;
  avatar?: string | null;
}

/** Vérifie une preuve d'identité envoyée par un client ; `null` si elle est invalide. */
export type Authenticator = (credential: string, meta: ConnectionMeta) => Promise<VerifiedIdentity | null>;
