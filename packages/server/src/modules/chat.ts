/**
 * Module « chat » : discussion texte dans le salon, avec canaux et destinataires.
 *
 * Par défaut un seul canal, « all », ouvert à tous les membres (et affiché sur les écrans,
 * pratique en stream). Un jeu peut définir d'autres canaux et leurs destinataires avec
 * `audience`, par exemple le chat secret des participants de DCDS, que le décideur de la
 * manche ne voit pas :
 *
 *   chatModule({
 *     audience: (channel, sender, ctx) => {
 *       if (channel === "all") return "all";
 *       if (channel === "participants") {
 *         const state = ctx.gameState() as MyState | null;
 *         if (!state || sender.memberId === state.deciderId) return null; // refusé
 *         return ctx.playerIds().filter((id) => id !== state.deciderId);
 *       }
 *       return null;
 *     },
 *   })
 *
 * Les destinataires sont figés à l'envoi : un message ne devient jamais visible a posteriori
 * pour quelqu'un qui n'était pas dans l'audience.
 */

import { CHAT_MAX_LENGTH, GameError, sanitizeLine, type ChatMessage } from "@gamecore/core";
import { TokenBucket } from "../rate-limit.js";
import type { ModuleContext, Recipient, Sender, ServerModule } from "./module.js";

/** « all » = tout le salon (écrans compris) ; liste = ces membres-là ; `null` = envoi refusé. */
export type ChatAudience = "all" | readonly string[] | null;

export interface ChatModuleOptions {
  /** Longueur max d'un message (en caractères perçus), 280 par défaut. */
  maxLength?: number;
  /** Nombre de messages conservés et renvoyés à une connexion qui arrive, 50 par défaut. */
  history?: number;
  /** Débit max par membre : messages par 10 secondes, 5 par défaut. */
  messagesPer10s?: number;
  /** Les spectateurs peuvent-ils écrire ? Oui par défaut. */
  spectatorsCanWrite?: boolean;
  /** Destinataires d'un message selon son canal (voir l'exemple ci-dessus). */
  audience?(channel: string, sender: Sender, ctx: ModuleContext): ChatAudience;
}

interface StoredMessage {
  message: ChatMessage;
  audience: "all" | readonly string[];
}

interface ChatState {
  seq: number;
  log: StoredMessage[];
  buckets: Map<string, TokenBucket>;
}

export const CHAT_MODULE = "chat";

const canSee = (audience: StoredMessage["audience"], r: Recipient) =>
  audience === "all" || (r.memberId !== null && audience.includes(r.memberId));

export function chatModule(options: ChatModuleOptions = {}): ServerModule {
  const maxLength = options.maxLength ?? CHAT_MAX_LENGTH;
  const historySize = options.history ?? 50;
  const per10s = options.messagesPer10s ?? 5;
  const init = (): ChatState => ({ seq: 0, log: [], buckets: new Map() });

  return {
    name: CHAT_MODULE,
    handles: ["chat"],

    handle(ctx, sender, message) {
      if (message.t !== "chat") return undefined;
      const member = sender.member;
      if (!member) throw new GameError("FORBIDDEN", "Un écran ne peut pas écrire dans le chat.");
      if (member.role === "spectator" && options.spectatorsCanWrite === false) {
        throw new GameError("FORBIDDEN", "Les spectateurs ne peuvent pas écrire.");
      }
      const body = sanitizeLine(message.body, maxLength);
      if (!body) throw new GameError("BAD_REQUEST", "Message vide.");

      const state = ctx.state(init);
      let bucket = state.buckets.get(member.id);
      if (!bucket) {
        bucket = new TokenBucket(per10s / 10, per10s, () => ctx.now());
        state.buckets.set(member.id, bucket);
      }
      if (!bucket.take()) throw new GameError("RATE_LIMITED", "Doucement sur le chat !");

      const channel = message.channel ?? "all";
      const audience = options.audience
        ? options.audience(channel, sender, ctx)
        : channel === "all"
          ? "all"
          : null;
      if (audience === null) throw new GameError("FORBIDDEN", "Tu ne peux pas écrire sur ce canal.");

      const chat: ChatMessage = {
        id: ++state.seq,
        from: member.id,
        name: member.name,
        channel,
        body,
        at: ctx.now(),
      };
      // Copie de la liste : une audience calculée par le jeu ne doit pas pouvoir changer après coup.
      const frozen = audience === "all" ? "all" : [...audience];
      state.log.push({ message: chat, audience: frozen });
      if (state.log.length > historySize) state.log.splice(0, state.log.length - historySize);

      ctx.send((r) => canSee(frozen, r), { t: "chat", message: chat });
      return { id: chat.id };
    },

    onAttach(ctx, recipient) {
      const state = ctx.state(init);
      for (const stored of state.log) {
        if (canSee(stored.audience, recipient))
          ctx.sendTo(recipient.connectionId, { t: "chat", message: stored.message });
      }
    },

    onMemberLeave(ctx, memberId) {
      ctx.state(init).buckets.delete(memberId);
    },
  };
}
