/**
 * Réactions envoyées depuis les téléphones (module « controller ») et affichées sur l'écran.
 * Liste fermée : impossible d'envoyer un texte arbitraire sur l'écran de l'hôte.
 */

import { z } from "zod";

export const REACTIONS = ["👏", "😂", "😱", "🔥", "🤔", "😭"] as const;
export type Reaction = (typeof REACTIONS)[number];

export const reactionSchema = z.strictObject({ reaction: z.enum(REACTIONS) });
