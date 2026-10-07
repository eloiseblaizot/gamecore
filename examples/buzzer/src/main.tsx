/**
 * Point d'entrée du navigateur.
 *
 * ⚠️ Le jeu (`game.ts`) n'est importé qu'en `import type` dans tout le dossier src/ côté
 * navigateur : les questions et leurs réponses restent sur le serveur.
 */

import { GameClient } from "@gamecore/client";
import { socketIoTransport } from "@gamecore/client/socket-io";
import { GameProvider } from "@gamecore/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { Buzzer } from "./game.js";
import "./styles.css";

// Même origine que la page : en développement, Vite relaie /socket.io vers le serveur de jeu.
const client = new GameClient<Buzzer>({ transport: socketIoTransport() });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GameProvider client={client}>
      <App />
    </GameProvider>
  </StrictMode>,
);
