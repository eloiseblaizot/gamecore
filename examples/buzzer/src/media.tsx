/**
 * Vidéo et micros du Buzzer (LiveKit) : branchés sur les réglages de l'host, et sur le son
 * du jeu (la musique baisse quand quelqu'un parle).
 */

import { LiveKitMedia, MemberVideo, useMedia, useMemberMedia } from "@gamecore/livekit/react";
import { useRoom } from "@gamecore/react";
import type { ReactNode } from "react";
import { audio } from "./audio.js";
import type { Buzzer } from "./game.js";
import { Avatar } from "./ui/Avatar.js";

/** Médias du salon : connexion à la salle vidéo si l'host a activé caméras ou micros. */
export function BuzzerMedia({ children }: { children: ReactNode }) {
  const room = useRoom<Buzzer>();
  const enabled = !!room && (room.settings.camera || room.settings.micro);
  return (
    <LiveKitMedia
      enabled={enabled}
      onSpeakingChange={(speaking) => audio.setDuck(speaking)}
      startAudioClassName="btn btn-secondary start-audio"
    >
      {children}
    </LiveKitMedia>
  );
}

/** Avatar d'un joueur, remplacé par sa webcam quand elle est allumée ; entouré quand il parle. */
export function MemberFace({
  id,
  name,
  avatar,
  size = 48,
}: {
  id: string;
  name: string;
  avatar: string | null;
  size?: number;
}) {
  const media = useMemberMedia(id);
  return (
    <span
      className={`face${media?.speaking ? " is-speaking" : ""}`}
      style={{ width: size, height: size }}
      data-testid={`face-${name}`}
    >
      <MemberVideo
        memberId={id}
        className="face-video"
        fallback={<Avatar name={name} avatar={avatar} size={size} />}
      />
    </span>
  );
}

/** Mes commandes caméra / micro (seulement si j'ai le droit de publier). */
export function MediaControls() {
  const { local, error } = useMedia();
  if (!local && !error) return null;
  return (
    <div className="media-controls">
      {local?.canCamera && (
        <button
          type="button"
          className={`btn${local.camOn ? " btn-secondary" : ""}`}
          onClick={local.toggleCam}
        >
          {local.camOn ? "📷 Couper la caméra" : "📷 Allumer la caméra"}
        </button>
      )}
      {local?.canMicrophone && (
        <button
          type="button"
          className={`btn${local.micOn ? " btn-secondary" : ""}`}
          onClick={local.toggleMic}
        >
          {local.micOn ? "🎙️ Couper le micro" : "🎙️ Allumer le micro"}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
