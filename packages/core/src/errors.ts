/**
 * Erreurs partagées entre le serveur et les clients.
 *
 * Les codes sont stables et font partie du protocole : une interface peut s'en servir
 * pour afficher un message adapté (ex. « salon complet ») sans analyser le texte.
 */

export const ERROR_CODES = [
  /** Message mal formé, champ manquant ou invalide. */
  "BAD_REQUEST",
  /** Jeton de session absent, expiré ou invalide. */
  "UNAUTHORIZED",
  /** Action réservée (à l'host, aux joueurs…) ou membre banni. */
  "FORBIDDEN",
  /** Salon introuvable. */
  "NOT_FOUND",
  /** Plus de place dans le salon. */
  "ROOM_FULL",
  /** L'host a verrouillé le salon : plus personne ne peut entrer. */
  "ROOM_LOCKED",
  /** Action impossible pendant une partie (ex. changer les réglages). */
  "GAME_RUNNING",
  /** Action de jeu alors qu'aucune partie n'est en cours. */
  "NOT_PLAYING",
  /** Action refusée par les règles du jeu (« ce n'est pas ton tour »). */
  "RULE",
  /** Trop de messages en peu de temps. */
  "RATE_LIMITED",
  /** Message trop volumineux. */
  "PAYLOAD_TOO_LARGE",
  /** Fonctionnalité d'un module non activé sur ce serveur. */
  "MODULE_DISABLED",
  /** (client) Pas de réponse du serveur dans le délai imparti. */
  "TIMEOUT",
  /** (client) Connexion perdue avant la réponse. */
  "DISCONNECTED",
  /** Erreur inattendue côté serveur : le détail reste dans les journaux du serveur. */
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Erreur « métier » : son message est destiné à être affiché au joueur. */
export class GameError extends Error {
  override readonly name = "GameError";
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }

  toJSON(): { code: ErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isGameError(value: unknown): value is GameError {
  return value instanceof GameError;
}

/** Message générique renvoyé à la place d'une erreur inattendue (pour ne rien divulguer). */
export const INTERNAL_ERROR_MESSAGE = "Erreur inattendue du serveur, réessaie.";
