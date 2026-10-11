/**
 * Liaisons React pour la vidéo et l'audio (repris de DCDS et rendu générique).
 *
 *   <LiveKitMedia enabled={settings.camera} onSpeakingChange={(on) => audio.setDuck(on)}>
 *     <MemberVideo memberId={player.id} fallback={<Avatar … />} />
 *   </LiveKitMedia>
 *
 * Le fournisseur demande un jeton au salon (`client.module("livekit", …)`) et se connecte à
 * la salle LiveKit ; l'interface ne manipule ensuite que des « tuiles » par identifiant de
 * membre (vidéo, parle ou non, caméra et micro coupés). `LocalMedia` fournit la même chose
 * avec la seule webcam locale, pour le mode démo.
 */

import {
  isTrackReference,
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  useLocalParticipant,
  useParticipants,
  useTracks,
  VideoTrack,
  type TrackReference,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { useGameClient, useRoom, useYou } from "@gamecore/react";
import { Track, VideoPresets, type Participant } from "livekit-client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LiveKitAccess } from "./server.js";

/** Ce que l'on sait des médias d'un membre. */
export interface MemberMedia {
  video?: TrackReference | MediaStream;
  speaking: boolean;
  camOff: boolean;
  micOff: boolean;
  isLocal: boolean;
}

export interface MediaState {
  kind: "none" | "livekit" | "local";
  /** Médias par identifiant de membre. */
  tiles: Record<string, MemberMedia>;
  /** Commandes de mes propres médias (`null` si je ne publie rien). */
  local: {
    camOn: boolean;
    micOn: boolean;
    canCamera: boolean;
    canMicrophone: boolean;
    toggleCam(): void;
    toggleMic(): void;
  } | null;
  /** Quelqu'un d'autre que moi parle-t-il ? (pour baisser la musique) */
  someoneSpeaking: boolean;
  error: string | null;
}

export const NO_MEDIA: MediaState = {
  kind: "none",
  tiles: {},
  local: null,
  someoneSpeaking: false,
  error: null,
};

const MediaContext = createContext<MediaState>(NO_MEDIA);

/** État des médias du salon. */
export const useMedia = (): MediaState => useContext(MediaContext);

/** Médias d'un membre (ou `undefined`). */
export const useMemberMedia = (memberId: string | null | undefined): MemberMedia | undefined =>
  useContext(MediaContext).tiles[memberId ?? ""];

/** Tuiles construites à partir des participants LiveKit et des pistes caméra (fonction pure). */
export function tilesFrom(
  participants: readonly Pick<
    Participant,
    "identity" | "isSpeaking" | "isCameraEnabled" | "isMicrophoneEnabled" | "isLocal"
  >[],
  cameraTracks: readonly TrackReferenceOrPlaceholder[],
): Record<string, MemberMedia> {
  const tiles: Record<string, MemberMedia> = {};
  for (const p of participants) {
    tiles[p.identity] = {
      speaking: p.isSpeaking,
      camOff: !p.isCameraEnabled,
      micOff: !p.isMicrophoneEnabled,
      isLocal: p.isLocal,
    };
  }
  for (const ref of cameraTracks) {
    if (!isTrackReference(ref) || ref.publication.isMuted) continue;
    const id = ref.participant.identity;
    tiles[id] = {
      ...(tiles[id] ?? { speaking: false, camOff: false, micOff: true, isLocal: false }),
      video: ref,
    };
  }
  return tiles;
}

export interface LiveKitMediaProps {
  /** Vidéo activée pour ce salon (ex. réglage de l'host). Sans elle, aucune connexion. */
  enabled: boolean;
  children: ReactNode;
  /** Appelé quand quelqu'un (d'autre) se met à parler ou s'arrête. */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Libellé du bouton qui autorise le son (règle d'autoplay des navigateurs). */
  startAudioLabel?: string;
  startAudioClassName?: string;
}

/**
 * Connexion à la salle vidéo du salon. Le jeton est redemandé quand mes droits changent
 * (rôle, réglages de l'host), et la connexion fermée quand la vidéo est désactivée.
 */
export function LiveKitMedia({
  enabled,
  children,
  onSpeakingChange,
  startAudioLabel = "🔊 Activer le son des participants",
  startAudioClassName,
}: LiveKitMediaProps) {
  const client = useGameClient();
  const room = useRoom();
  const you = useYou();
  const available = enabled && !!room?.modules.includes("livekit");
  const member = room?.members.find((m) => m.id === you?.id);
  // Ce qui change mes droits : la demande de jeton est refaite si l'une de ces valeurs change.
  const rightsKey = available
    ? `${room?.code}|${you?.kind}|${member?.role}|${JSON.stringify(room?.settings)}`
    : null;
  const [access, setAccess] = useState<LiveKitAccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rightsKey) return;
    let alive = true;
    client
      .module<LiveKitAccess | null>("livekit", { op: "token" })
      .then((res) => {
        if (alive) {
          setAccess(res);
          setError(null);
        }
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
      setAccess(null);
    };
  }, [client, rightsKey]);

  if (!available || !access) {
    return <MediaContext value={{ ...NO_MEDIA, error: available ? error : null }}>{children}</MediaContext>;
  }

  const { camera, microphone } = access.publish;
  return (
    <LiveKitRoom
      serverUrl={access.url}
      token={access.token}
      connect
      audio={microphone}
      video={camera ? { resolution: VideoPresets.h360.resolution } : false}
      options={{ adaptiveStream: true, dynacast: true }}
      style={{ display: "contents" }}
      onError={(err) => setError(err.message)}
      onMediaDeviceFailure={() => setError("Impossible d'accéder à ta caméra ou à ton micro.")}
    >
      <Bridge publish={access.publish} error={error} onSpeakingChange={onSpeakingChange}>
        {children}
      </Bridge>
      <RoomAudioRenderer />
      <StartAudio label={startAudioLabel} className={startAudioClassName} />
    </LiveKitRoom>
  );
}

function Bridge({
  publish,
  error,
  onSpeakingChange,
  children,
}: {
  publish: LiveKitAccess["publish"];
  error: string | null;
  onSpeakingChange?: (speaking: boolean) => void;
  children: ReactNode;
}) {
  const cameraTracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const participants = useParticipants();
  const { localParticipant, isCameraEnabled, isMicrophoneEnabled } = useLocalParticipant();

  const value = useMemo<MediaState>(() => {
    const tiles = tilesFrom(participants, cameraTracks);
    return {
      kind: "livekit",
      tiles,
      someoneSpeaking: participants.some((p) => !p.isLocal && p.isSpeaking),
      error,
      local:
        publish.camera || publish.microphone
          ? {
              camOn: isCameraEnabled,
              micOn: isMicrophoneEnabled,
              canCamera: publish.camera,
              canMicrophone: publish.microphone,
              toggleCam: () => void localParticipant.setCameraEnabled(!isCameraEnabled),
              toggleMic: () => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled),
            }
          : null,
    };
  }, [participants, cameraTracks, error, publish, isCameraEnabled, isMicrophoneEnabled, localParticipant]);

  useSpeakingCallback(value.someoneSpeaking, onSpeakingChange);
  return <MediaContext value={value}>{children}</MediaContext>;
}

/** Prévient l'application quand « quelqu'un parle » change (sans relancer à chaque rendu). */
function useSpeakingCallback(speaking: boolean, callback?: (speaking: boolean) => void) {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    latest.current?.(speaking);
  }, [speaking]);
}

/**
 * Médias locaux seulement (mode démo, aperçu) : ma webcam, sans serveur. Les autres
 * membres n'ont pas de vidéo.
 */
export function LocalMedia({ memberId, children }: { memberId: string | null; children: ReactNode }) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const value = useMemo<MediaState>(() => {
    const toggleCam = () => {
      if (stream) {
        setStream(null);
        return;
      }
      navigator.mediaDevices
        .getUserMedia({ video: { width: 640, height: 360 }, audio: false })
        .then((s) => {
          setStream(s);
          setError(null);
        })
        .catch(() => setError("Caméra indisponible ou refusée."));
    };
    const tiles: Record<string, MemberMedia> = {};
    if (memberId) {
      tiles[memberId] = {
        video: stream ?? undefined,
        speaking: false,
        camOff: !stream,
        micOff: true,
        isLocal: true,
      };
    }
    return {
      kind: "local",
      tiles,
      someoneSpeaking: false,
      error,
      local: {
        camOn: !!stream,
        micOn: false,
        canCamera: true,
        canMicrophone: false,
        toggleCam,
        toggleMic: () => {},
      },
    };
  }, [memberId, stream, error]);

  return <MediaContext value={value}>{children}</MediaContext>;
}

/** Vidéo d'un membre (LiveKit ou webcam locale), ou `fallback` s'il n'en a pas. */
export function MemberVideo({
  memberId,
  className,
  fallback = null,
}: {
  memberId: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const media = useMemberMedia(memberId);
  const video = media?.video;
  if (!video || media.camOff) return <>{fallback}</>;
  if (video instanceof MediaStream)
    return <StreamVideo stream={video} className={className} mirrored={media.isLocal} />;
  return (
    <VideoTrack
      trackRef={video}
      className={className}
      data-member={memberId}
      style={media.isLocal ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}

function StreamVideo({
  stream,
  className,
  mirrored,
}: {
  stream: MediaStream;
  className?: string;
  mirrored: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted
      style={mirrored ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}
