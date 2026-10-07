/**
 * Protocole réseau entre les clients et le serveur (JSON sur WebSocket, quel que soit
 * le transport : Socket.io, PartyKit ou connexion locale).
 *
 * Règle d'or : le serveur ne fait confiance à RIEN de ce qu'envoie un client. Chaque
 * message entrant est borné en taille, limité en débit, puis validé par ces schémas
 * stricts (`z.strictObject` : un champ inattendu suffit à rejeter le message).
 *
 * Voir `docs/protocole.md` pour la séquence complète des échanges.
 */

import { z } from "zod";
import type { ErrorCode } from "./errors.js";
import type { ChatMessage, GameSnapshot, RoomInfo, You } from "./types.js";

/** Version du protocole, vérifiée à la connexion (incrémentée à chaque changement incompatible). */
export const PROTOCOL_VERSION = 1;

/** Limites par défaut, ajustables dans les options du serveur. */
export const DEFAULT_LIMITS = {
  /** Taille max d'un message entrant (octets UTF-8). */
  maxMessageBytes: 16 * 1024,
  /** Messages par seconde (débit soutenu) et rafale autorisée, par connexion. */
  messagesPerSecond: 20,
  messageBurst: 40,
  /** Entrées de manette par seconde (joystick…), par connexion. */
  inputsPerSecond: 60,
  /** Tentatives d'entrée ratées (code inconnu, jeton invalide) par minute et par adresse IP. */
  failedJoinsPerMinute: 12,
  /** Membres max par salon (joueurs + spectateurs). */
  maxMembers: 64,
  /** Écrans max par salon. */
  maxScreens: 4,
} as const;

export type Limits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

// --- Briques ---------------------------------------------------------------

/** Identifiant de requête choisi par le client, renvoyé dans la réponse (`ack` / `error`). */
const requestId = z
  .number()
  .int()
  .min(0)
  .max(2 ** 31 - 1);
/** Code de salon tel que saisi (normalisé ensuite par le serveur). */
const roomCode = z.string().min(4).max(16);
/** Jeton opaque en base64url. */
const token = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const memberId = z.string().min(1).max(64);
/** Profil brut : le serveur le nettoie ensuite (`sanitizeDisplayName`, `sanitizeAvatar`). */
const profile = z.strictObject({
  name: z.string().max(64),
  avatar: z.string().max(512).nullable().optional(),
});
/** Réglages bruts : validés ensuite par le schéma du jeu. */
const settingsPatch = z.record(z.string().max(64), z.unknown());

// --- Client → serveur ------------------------------------------------------

/** Opérations de salon (réservées à l'host, sauf `role`). */
export const lobbyOpSchema = z.discriminatedUnion("op", [
  /** Lancer la partie. */
  z.strictObject({ op: z.literal("start") }),
  /** Modifier les réglages (entre deux parties). */
  z.strictObject({ op: z.literal("settings"), settings: settingsPatch }),
  /** Expulser un membre (il ne pourra pas revenir avec le même jeton). */
  z.strictObject({ op: z.literal("kick"), memberId }),
  /** Transmettre le rôle d'host. */
  z.strictObject({ op: z.literal("promote"), memberId }),
  /** (Soi-même) passer joueur ou spectateur, dans le salon d'attente. */
  z.strictObject({ op: z.literal("role"), role: z.enum(["player", "spectator"]) }),
  /** Verrouiller / déverrouiller l'entrée dans le salon. */
  z.strictObject({ op: z.literal("lock"), locked: z.boolean() }),
  /** Arrêter la partie et revenir au salon d'attente. */
  z.strictObject({ op: z.literal("end") }),
]);

export type LobbyOp = z.infer<typeof lobbyOpSchema>;

export const clientMessageSchema = z.discriminatedUnion("t", [
  /** Créer un salon, en tant qu'écran partagé ou en tant que joueur (qui en devient l'host). */
  z.strictObject({
    t: z.literal("create"),
    id: requestId.optional(),
    v: z.literal(PROTOCOL_VERSION),
    as: z.enum(["screen", "player"]),
    profile: profile.optional(),
    settings: settingsPatch.optional(),
  }),
  /** Entrer dans un salon avec un pseudo (et éventuellement une preuve d'identité). */
  z.strictObject({
    t: z.literal("join"),
    id: requestId.optional(),
    v: z.literal(PROTOCOL_VERSION),
    code: roomCode,
    profile,
    spectator: z.boolean().optional(),
    /** Preuve d'identité vérifiée par le serveur (ex. jeton Discord), voir `authenticate`. */
    credential: z.string().max(4096).optional(),
  }),
  /** Reprendre sa place après une déconnexion ou un rechargement de page. */
  z.strictObject({
    t: z.literal("resume"),
    id: requestId.optional(),
    v: z.literal(PROTOCOL_VERSION),
    code: roomCode,
    token,
  }),
  /** Brancher un écran partagé (avec le jeton d'administration pour en garder les droits). */
  z.strictObject({
    t: z.literal("watch"),
    id: requestId.optional(),
    v: z.literal(PROTOCOL_VERSION),
    code: roomCode,
    adminToken: token.optional(),
  }),
  /** Quitter définitivement le salon. */
  z.strictObject({ t: z.literal("leave"), id: requestId.optional() }),
  /** Opération de salon. */
  z.strictObject({ t: z.literal("lobby"), id: requestId.optional(), op: lobbyOpSchema }),
  /** Action de jeu (validée ensuite par le schéma `actions` du jeu). */
  z.strictObject({ t: z.literal("action"), id: requestId.optional(), action: z.unknown() }),
  /** Entrée de manette temps réel, relayée aux écrans (module « controller »). */
  z.strictObject({ t: z.literal("input"), data: z.unknown() }),
  /** Message de chat (module « chat »). */
  z.strictObject({
    t: z.literal("chat"),
    id: requestId.optional(),
    channel: z.string().min(1).max(32).optional(),
    body: z.string().max(2000),
  }),
  /** Mesure de latence / maintien de la connexion. */
  z.strictObject({ t: z.literal("ping"), id: requestId.optional() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage["t"];

// --- Serveur → client ------------------------------------------------------

/** Réponse à `create`, `join`, `resume` et `watch`. */
export interface Welcome {
  code: string;
  kind: You["kind"];
  memberId: string | null;
  /**
   * Jeton à conserver pour revenir (session d'un membre, ou droits d'administration d'un
   * écran). Absent quand on reprend une session : le client garde celui qu'il a déjà.
   */
  token?: string;
}

export type ServerMessage<PublicView = unknown, PrivateView = unknown, Settings = unknown> =
  /** Réponse positive à une requête. */
  | { t: "ack"; ref: number; data?: unknown }
  /** Erreur, en réponse à une requête (`ref`) ou spontanée. */
  | { t: "error"; ref?: number; code: ErrorCode; message: string }
  /**
   * État complet du point de vue du destinataire. Envoyé après chaque changement ;
   * `version` augmente à chaque fois (un client ignore une version plus ancienne).
   */
  | {
      t: "sync";
      version: number;
      room: RoomInfo<Settings>;
      you: You;
      game: GameSnapshot<PublicView, PrivateView> | null;
    }
  /** Événement éphémère émis par le jeu (`ctx.emit`). */
  | { t: "event"; name: string; data?: unknown }
  /** Entrée de manette relayée à un écran. */
  | { t: "input"; from: string; data: unknown }
  /** Message de chat. */
  | { t: "chat"; message: ChatMessage }
  /** Fin de session (expulsion, salon fermé…). Le serveur ferme la connexion juste après. */
  | { t: "bye"; reason: ByeReason };

export type ByeReason = "kicked" | "left" | "closed" | "replaced";

/** Taille en octets UTF-8 d'un message (pour appliquer `maxMessageBytes`). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
