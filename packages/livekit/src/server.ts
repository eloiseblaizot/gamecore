/**
 * Module serveur LiveKit : le salon délivre lui-même les jetons d'accès à sa salle vidéo.
 *
 *   new GameServer({
 *     game,
 *     modules: [livekitModule({ url, apiKey, apiSecret, policy: ({ member, settings }) => … })],
 *   });
 *
 * Pourquoi par le salon ? Parce que lui seul sait qui est membre, avec quel rôle : un jeton
 * n'est délivré qu'à une connexion attachée au salon, avec exactement les droits voulus
 * (les joueurs publient, les spectateurs regardent, l'écran partagé est invisible). Le
 * secret LiveKit ne quitte jamais le serveur ; l'identité LiveKit EST l'identifiant de
 * membre, signée dans le jeton : impossible de publier sous le nom de quelqu'un d'autre.
 */

import { GameError, isBot, type MemberInfo, type RoomStatus, type Viewer } from "@gamecore/core";
import { TokenBucket, type ModuleContext, type ServerModule } from "@gamecore/server";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import { z } from "zod";

export const LIVEKIT_MODULE = "livekit";

/** Ce qu'un membre a le droit de publier. */
export interface MediaGrant {
  camera: boolean;
  microphone: boolean;
}

export interface MediaPolicyContext {
  viewer: Viewer;
  /** Le membre (`null` pour un écran partagé). */
  member: MemberInfo | null;
  /** Réglages de la partie (ex. caméras autorisées par l'host). */
  settings: unknown;
  status: RoomStatus;
}

/**
 * Politique des médias : ce que ce destinataire peut publier, ou `null` s'il n'a pas accès
 * à la vidéo du tout (aucune connexion LiveKit n'est alors ouverte).
 */
export type MediaPolicy = (ctx: MediaPolicyContext) => { publish: MediaGrant } | null;

/** Par défaut : les joueurs publient caméra et micro, les autres regardent et écoutent. */
export const defaultMediaPolicy: MediaPolicy = ({ member }) => ({
  publish:
    member?.role === "player" ? { camera: true, microphone: true } : { camera: false, microphone: false },
});

export interface LiveKitModuleOptions {
  /** Adresse du serveur LiveKit (ex. wss://monjeu.livekit.cloud). */
  url: string;
  apiKey: string;
  /** Secret de l'API LiveKit : uniquement côté serveur. */
  apiSecret: string;
  policy?: MediaPolicy;
  /** Durée de validité d'un jeton (2 h par défaut). */
  ttlSeconds?: number;
  /** Jetons par minute et par connexion (10 par défaut). */
  tokensPerMinute?: number;
}

/** Réponse à `client.module("livekit", { op: "token" })`. */
export interface LiveKitAccess {
  url: string;
  token: string;
  /** Identité LiveKit : identifiant de membre (ou identifiant d'écran). */
  identity: string;
  publish: MediaGrant;
}

const requestSchema = z.strictObject({ op: z.literal("token") });

export function livekitModule(options: LiveKitModuleOptions): ServerModule {
  if (!/^wss?:\/\//.test(options.url))
    throw new Error("LIVEKIT_URL doit commencer par wss:// (ou ws:// en local).");
  if (!options.apiKey || !options.apiSecret) throw new Error("Clé et secret LiveKit requis.");
  const policy = options.policy ?? defaultMediaPolicy;
  const ttl = options.ttlSeconds ?? 2 * 60 * 60;
  const perMinute = options.tokensPerMinute ?? 10;

  return {
    name: LIVEKIT_MODULE,
    handles: ["module"],

    async handle(ctx: ModuleContext, sender, message): Promise<LiveKitAccess | null> {
      if (message.t !== "module") return null;
      if (!requestSchema.safeParse(message.data).success)
        throw new GameError("BAD_REQUEST", "Demande vidéo invalide.");
      if (sender.member && isBot(sender.member))
        throw new GameError("FORBIDDEN", "Les bots n'ont pas de caméra.");

      const buckets = ctx.state(() => new Map<string, TokenBucket>());
      let bucket = buckets.get(sender.connectionId);
      if (!bucket) {
        bucket = new TokenBucket(perMinute / 60, perMinute, () => ctx.now());
        buckets.set(sender.connectionId, bucket);
      }
      if (!bucket.take()) throw new GameError("RATE_LIMITED", "Trop de demandes vidéo, patiente un peu.");

      const access = policy({
        viewer: sender.viewer,
        member: sender.member,
        settings: ctx.settings,
        status: ctx.status,
      });
      if (!access) return null;
      const publish = { camera: access.publish.camera, microphone: access.publish.microphone };

      // Un écran n'a pas d'identifiant de membre : identité dérivée de sa connexion, et invisible.
      const identity = sender.member?.id ?? `screen-${await shortHash(sender.connectionId)}`;
      const token = new AccessToken(options.apiKey, options.apiSecret, {
        identity,
        name: sender.member?.name ?? "Écran",
        ttl,
        metadata: JSON.stringify({ avatar: sender.member?.avatar ?? null }),
      });
      const sources: TrackSource[] = [];
      if (publish.camera) sources.push(TrackSource.CAMERA);
      if (publish.microphone) sources.push(TrackSource.MICROPHONE);
      token.addGrant({
        // Le nom de salle repose sur l'identifiant aléatoire du salon, jamais réutilisé
        // (contrairement au code) : un ancien jeton n'ouvre pas la salle d'un nouveau salon.
        room: livekitRoomName(ctx.roomId),
        roomJoin: true,
        canSubscribe: true,
        canPublish: sources.length > 0,
        canPublishSources: sources,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        hidden: sender.viewer.kind === "screen",
      });
      return { url: options.url, token: await token.toJwt(), identity, publish };
    },

    onMemberLeave(ctx) {
      // Les compteurs sont par connexion : on fait le ménage de temps en temps.
      const buckets = ctx.state(() => new Map<string, TokenBucket>());
      if (buckets.size > 256) buckets.clear();
    },
  };
}

/** Nom de la salle LiveKit d'un salon gamecore. */
export function livekitRoomName(roomId: string): string {
  return `gc-${roomId}`;
}

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}
