/**
 * Modules serveur : fonctionnalités optionnelles branchées sur chaque salon.
 *
 * Un module déclare les types de messages client qu'il prend en charge (`handles`) et
 * reçoit un contexte limité au salon : il peut lire les membres, envoyer des messages et
 * garder un état propre au salon, mais il ne touche jamais à l'état du jeu. Les modules
 * fournis : `controllerModule` (manettes) et `chatModule` (discussion). Voir `docs/modules.md`.
 */

import type {
  ClientMessage,
  ClientMessageType,
  MemberInfo,
  RoomStatus,
  ServerMessage,
  Viewer,
} from "@gamecore/core";
import type { Logger } from "../logger.js";

/** Un destinataire potentiel d'un message (connexion attachée au salon). */
export interface Recipient {
  readonly connectionId: string;
  readonly viewer: Viewer;
  /** Identifiant de membre, `null` pour un écran. */
  readonly memberId: string | null;
}

/** L'auteur d'un message reçu par un module. */
export interface Sender extends Recipient {
  /** Le membre (pseudo, rôle…), `null` pour un écran. */
  readonly member: MemberInfo | null;
}

export interface ModuleContext {
  readonly code: string;
  readonly status: RoomStatus;
  readonly hostId: string | null;
  readonly logger: Logger;
  now(): number;
  members(): MemberInfo[];
  /** Joueurs de la partie en cours (vide hors partie). */
  playerIds(): readonly string[];
  /**
   * État COMPLET du jeu en cours (lecture seule), pour les modules qui en dépendent
   * (ex. chat réservé aux participants d'une manche). Ne jamais le renvoyer tel quel.
   */
  gameState(): unknown;
  /** Envoie un message à chaque connexion du salon qui satisfait `filter`. */
  send(filter: (recipient: Recipient) => boolean, message: ServerMessage): void;
  /** Envoie un message à une seule connexion. */
  sendTo(connectionId: string, message: ServerMessage): void;
  /** État du module propre à ce salon, créé au premier appel. */
  state<T>(init: () => T): T;
}

export interface ServerModule {
  /** Nom unique, publié aux clients dans `RoomInfo.modules`. */
  readonly name: string;
  /** Types de messages client pris en charge (ex. `["input"]`). */
  readonly handles?: readonly ClientMessageType[];
  /**
   * Traite un message. La valeur renvoyée est transmise au client dans l'`ack` ;
   * une `GameError` levée lui est renvoyée comme erreur.
   */
  handle?(ctx: ModuleContext, sender: Sender, message: ClientMessage): unknown;
  /** Une connexion vient d'arriver ou de revenir dans le salon (ex. envoyer l'historique). */
  onAttach?(ctx: ModuleContext, recipient: Recipient): void;
  /** Un membre a définitivement quitté le salon. */
  onMemberLeave?(ctx: ModuleContext, memberId: string): void;
}
