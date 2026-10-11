/**
 * Web Worker de la simulation : elle tourne hors du fil principal, la page ne reçoit que les
 * canaux publiés (la grille, transférée sans copie supplémentaire, et les statistiques).
 */

import { exposeSimulation } from "@gamecore/sim/worker";
import { foxesAndRabbits } from "./simulation";

exposeSimulation(foxesAndRabbits, self);
