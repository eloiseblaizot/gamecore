/**
 * @gamecore/server — runtime de salon autoritaire, indépendant du transport.
 *
 * Transports : `@gamecore/server/socket-io` (Node), PartyKit (à venir), ou connexion locale
 * dans le navigateur (`@gamecore/client/local`, mode démo). Tests : `@gamecore/server/testing`.
 */

export { systemClock, type Clock } from "./clock.js";
export type { Authenticator, Connection, ConnectionMeta, VerifiedIdentity } from "./connection.js";
export { consoleLogger, silentLogger, type Logger } from "./logger.js";
export { CHAT_MODULE, chatModule, type ChatAudience, type ChatModuleOptions } from "./modules/chat.js";
export { CONTROLLER_MODULE, controllerModule, type ControllerModuleOptions } from "./modules/controller.js";
export type { ModuleContext, Recipient, Sender, ServerModule } from "./modules/module.js";
export { SlidingWindowCounter, TokenBucket } from "./rate-limit.js";
export { Room, type Identity, type RoomOptions } from "./room.js";
export { GameServer, type GameServerOptions } from "./server.js";
