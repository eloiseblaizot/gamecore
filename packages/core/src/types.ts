/**
 * Types partagés décrivant un salon, ses membres et ce que chaque client reçoit.
 */

/** Cycle de vie d'un salon : attente → partie → résultats (puis retour au salon d'attente). */
export type RoomStatus = "lobby" | "playing" | "finished";

/** Un membre joue la partie ou la regarde. */
export type MemberRole = "player" | "spectator";

/** Origine de l'identité d'un membre : invité (pseudo libre) ou fournisseur vérifié. */
export type IdentityProvider = "guest" | "discord" | (string & {});

/** Ce qu'un membre choisit pour se présenter. */
export interface Profile {
  name: string;
  /** Emoji court ou URL HTTPS d'un hôte autorisé (voir `sanitizeAvatar`). */
  avatar: string | null;
}

/** Un membre du salon tel que le voient tous les clients. */
export interface MemberInfo extends Profile {
  id: string;
  role: MemberRole;
  connected: boolean;
  isHost: boolean;
  provider: IdentityProvider;
}

/** Un joueur tel que le voit le jeu (règles et vues). */
export interface PlayerInfo extends Profile {
  id: string;
  connected: boolean;
}

/**
 * Qui regarde : un joueur (sur son téléphone ou son PC), un spectateur, ou un écran partagé
 * (télé, PC de l'hôte en stream…) qui n'affiche que l'information publique.
 */
export type Viewer =
  | { kind: "player"; id: string; isHost: boolean }
  | { kind: "spectator"; id: string; isHost: boolean }
  | { kind: "screen"; isHost: boolean };

/** Qui agit : un client, ou le système (minuteur programmé par le jeu). */
export type Actor = Viewer | { kind: "system" };

/** Description publique du jeu, envoyée aux clients. */
export interface GameInfo {
  id: string;
  name: string;
  minPlayers: number;
  maxPlayers: number;
}

/** État du salon (hors partie), identique pour tout le monde. */
export interface RoomInfo<Settings = unknown> {
  code: string;
  status: RoomStatus;
  hostId: string | null;
  locked: boolean;
  settings: Settings;
  members: MemberInfo[];
  /** Nombre d'écrans partagés connectés. */
  screens: number;
  game: GameInfo;
  /** Modules activés sur le serveur (ex. "controller", "chat"). */
  modules: string[];
}

/** Ce qu'un client sait de la partie : la vue publique, plus sa vue privée s'il joue. */
export interface GameSnapshot<PublicView = unknown, PrivateView = unknown> {
  public: PublicView;
  /** Présent uniquement pour un joueur : ce que LUI SEUL a le droit de voir. */
  private?: PrivateView;
}

/** Qui je suis, du point de vue du serveur. */
export interface You {
  kind: Viewer["kind"];
  /** Identifiant de membre (null pour un écran). */
  id: string | null;
  isHost: boolean;
}

/** Message de chat diffusé par le module « chat ». */
export interface ChatMessage {
  id: number;
  from: string | null;
  name: string;
  channel: string;
  body: string;
  at: number;
}
