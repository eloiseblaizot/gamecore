/**
 * Journalisation minimale, branchable sur n'importe quel outil (pino, console, Sentry…).
 *
 * Le runtime n'y écrit JAMAIS de jeton, de contenu de message ni d'état de partie complet :
 * seulement des codes de salon, des identifiants techniques et des erreurs.
 */

export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/** Journal sur la console, sans le niveau `debug`. */
export const consoleLogger: Logger = {
  debug: () => {},
  info: (message, details) => console.info(`[gamecore] ${message}`, details ?? ""),
  warn: (message, details) => console.warn(`[gamecore] ${message}`, details ?? ""),
  error: (message, details) => console.error(`[gamecore] ${message}`, details ?? ""),
};

/** Journal muet (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
