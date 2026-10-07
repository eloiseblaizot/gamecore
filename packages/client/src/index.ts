/**
 * @gamecore/client — connexion d'un navigateur à un salon gamecore.
 *
 * Transports : `@gamecore/client/socket-io` (serveur Node), `@gamecore/client/local`
 * (serveur dans la page : démo, tests). PartyKit : à venir.
 */

export { GameClient, type ClientState, type ConnectionStatus, type GameClientOptions } from "./client.js";
export { Emitter } from "./emitter.js";
export { browserSessionStore, memoryStore, type SessionStore, type StoredSession } from "./storage.js";
export type { ClientTransport, TransportHandlers } from "./transport.js";
export { GameError, isGameError, type ErrorCode } from "@gamecore/core";
