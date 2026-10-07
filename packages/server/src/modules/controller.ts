/**
 * Module « manettes » : les téléphones des joueurs deviennent des manettes.
 *
 * Deux façons de jouer avec un téléphone coexistent dans gamecore :
 *   1. les ACTIONS (`client.act`) : fiables, validées par les règles du jeu, diffusées à
 *      tous. Idéal pour un quiz, un jeu de cartes, un vote — c'est le cas le plus courant ;
 *   2. les ENTRÉES (ce module) : un flux temps réel (joystick, boutons maintenus, gyroscope)
 *      RELAYÉ tel quel à l'écran de l'hôte, sans passer par l'état du jeu. Idéal quand
 *      c'est l'écran qui fait tourner la simulation (course, jeu de plateforme…).
 *
 * Les entrées sont « avec perte » : au-delà du débit autorisé, elles sont ignorées sans
 * erreur (une position de joystick périmée ne sert à rien de toute façon).
 */

import { GameError } from "@gamecore/core";
import type { z } from "zod";
import { TokenBucket } from "../rate-limit.js";
import type { Recipient, ServerModule } from "./module.js";

export interface ControllerModuleOptions<Input = unknown> {
  /** Schéma des entrées acceptées. Fortement recommandé : sans lui, tout JSON est relayé. */
  schema?: z.ZodType<Input>;
  /** Débit max par membre (entrées par seconde), 60 par défaut. */
  inputsPerSecond?: number;
  /** Qui reçoit les entrées : les écrans (défaut), ou aussi l'host. */
  to?: "screens" | "screens-and-host";
  /** Qui peut en envoyer : les joueurs de la partie (défaut) ou tous les membres. */
  from?: "players" | "members";
  /** Accepter les entrées dans le salon d'attente (ex. faire bouger son avatar). Oui par défaut. */
  inLobby?: boolean;
}

export const CONTROLLER_MODULE = "controller";

export function controllerModule<Input = unknown>(
  options: ControllerModuleOptions<Input> = {},
): ServerModule {
  const rate = options.inputsPerSecond ?? 60;
  const from = options.from ?? "players";
  const to = options.to ?? "screens";
  const inLobby = options.inLobby ?? true;
  const isTarget = (r: Recipient) =>
    r.viewer.kind === "screen" || (to === "screens-and-host" && r.viewer.isHost);

  return {
    name: CONTROLLER_MODULE,
    handles: ["input"],

    handle(ctx, sender, message) {
      if (message.t !== "input") return undefined;
      if (!sender.member) throw new GameError("FORBIDDEN", "Un écran n'envoie pas d'entrées de manette.");
      if (!inLobby && ctx.status !== "playing") return undefined;
      if (from === "players" && sender.viewer.kind !== "player") {
        throw new GameError("FORBIDDEN", "Seuls les joueurs ont une manette.");
      }

      const buckets = ctx.state(() => new Map<string, TokenBucket>());
      let bucket = buckets.get(sender.member.id);
      if (!bucket) {
        bucket = new TokenBucket(rate, Math.ceil(rate / 2), () => ctx.now());
        buckets.set(sender.member.id, bucket);
      }
      if (!bucket.take()) return undefined;

      let data: unknown = message.data;
      if (options.schema) {
        const parsed = options.schema.safeParse(message.data);
        if (!parsed.success) throw new GameError("BAD_REQUEST", "Entrée de manette invalide.");
        data = parsed.data;
      }
      ctx.send(isTarget, { t: "input", from: sender.member.id, data });
      return undefined;
    },

    onMemberLeave(ctx, memberId) {
      ctx.state(() => new Map<string, TokenBucket>()).delete(memberId);
    },
  };
}
