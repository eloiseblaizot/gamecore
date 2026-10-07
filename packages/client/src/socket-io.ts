/**
 * Transport Socket.io côté navigateur.
 *
 *   import { GameClient } from "@gamecore/client";
 *   import { socketIoTransport } from "@gamecore/client/socket-io";
 *
 *   const client = new GameClient({ transport: socketIoTransport() }); // même origine que la page
 *
 * Socket.io se reconnecte tout seul après une coupure (réseau mobile, mise en veille) ;
 * `GameClient` reprend alors la session automatiquement.
 */

import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import type { ClientTransport } from "./transport.js";

/** Doit correspondre à `SOCKET_IO_EVENT` côté serveur. */
const EVENT = "gc";

export function socketIoTransport(
  url?: string,
  options: Partial<ManagerOptions & SocketOptions> = {},
): ClientTransport {
  let socket: Socket | null = null;
  return {
    connect(handlers) {
      socket?.disconnect();
      const opts: Partial<ManagerOptions & SocketOptions> = {
        // WebSocket d'abord ; repli sur le « long polling » si un réseau bloque les WebSockets.
        transports: ["websocket", "polling"],
        reconnectionDelayMax: 5000,
        ...options,
      };
      socket = url === undefined ? io(opts) : io(url, opts);
      socket.on("connect", handlers.open);
      socket.on("disconnect", handlers.close);
      socket.on(EVENT, (data: unknown) => {
        if (typeof data === "string") handlers.message(data);
      });
    },
    send(data) {
      socket?.emit(EVENT, data);
    },
    close() {
      socket?.disconnect();
      socket = null;
    },
  };
}
