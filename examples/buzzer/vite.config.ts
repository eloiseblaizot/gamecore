import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

/** Port du serveur de jeu (Socket.io) en développement. */
const serverPort = Number(process.env.GAME_SERVER_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Les paquets @gamecore/* sont lus depuis leurs sources : pas de build à lancer avant.
    conditions: ["source", ...defaultClientConditions],
  },
  server: {
    // En développement, Vite relaie les WebSockets vers le serveur de jeu.
    proxy: { "/socket.io": { target: `http://localhost:${serverPort}`, ws: true } },
  },
  build: {
    // Pas de « source maps » publiques en production : inutile d'exposer le code commenté.
    sourcemap: false,
  },
});
