/**
 * Primitives pour transformer un téléphone en manette.
 *
 * Conçues pour le tactile : réaction dès l'appui (pas d'attente du « clic »), pas de
 * défilement ni de zoom parasite (`touch-action: none`), retour haptique optionnel.
 * Elles restent utilisables au clavier (accessibilité, tests, jeu sur PC).
 */

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

// --- Vibrations et écran allumé ------------------------------------------------

/** Fait vibrer le téléphone (sans effet si l'appareil ou le navigateur ne le permet pas). */
export function vibrate(pattern: number | number[]): void {
  try {
    globalThis.navigator?.vibrate?.(pattern);
  } catch {
    // Certains navigateurs lèvent une erreur hors interaction utilisateur : sans importance.
  }
}

/**
 * Empêche l'écran du téléphone de se mettre en veille tant que `active` est vrai
 * (API Screen Wake Lock). Le verrou est repris quand l'onglet redevient visible.
 */
export function useWakeLock(active = true): void {
  useEffect(() => {
    const wakeLock = globalThis.navigator?.wakeLock;
    if (!active || !wakeLock) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      wakeLock
        .request("screen")
        .then((s) => {
          if (cancelled) void s.release();
          else sentinel = s;
        })
        .catch(() => undefined);
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}

// --- Bouton -----------------------------------------------------------------------

export interface ControllerButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  /** Appui (doigt posé, ou Entrée / Espace au clavier). */
  onPress?: () => void;
  /** Relâchement (doigt levé ou sorti du bouton). */
  onRelease?: () => void;
  /** Durée de vibration à l'appui (ms), 0 pour aucune. 15 par défaut. */
  haptic?: number;
}

const buttonStyle: CSSProperties = { touchAction: "none", userSelect: "none", WebkitUserSelect: "none" };

export function ControllerButton({
  onPress,
  onRelease,
  haptic = 15,
  style,
  disabled,
  ...rest
}: ControllerButtonProps) {
  const pressed = useRef(false);
  const press = () => {
    if (disabled || pressed.current) return;
    pressed.current = true;
    if (haptic > 0) vibrate(haptic);
    onPress?.();
  };
  const release = () => {
    if (!pressed.current) return;
    pressed.current = false;
    onRelease?.();
  };
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled}
      style={{ ...buttonStyle, ...style }}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          press();
        }
      }}
      onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === "Enter" || e.key === " ") release();
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

// --- Joystick ---------------------------------------------------------------------

export interface JoystickVector {
  /** De -1 (gauche) à 1 (droite). */
  x: number;
  /** De -1 (haut) à 1 (bas). */
  y: number;
}

export interface JoystickProps {
  /** Nouvelle position, au plus `rateHz` fois par seconde ; toujours (0, 0) au relâchement. */
  onMove: (vector: JoystickVector) => void;
  /** Diamètre en pixels (160 par défaut). */
  size?: number;
  /** Zone morte autour du centre, de 0 à 1 (0,12 par défaut). */
  deadZone?: number;
  /** Fréquence max d'envoi (30 Hz par défaut). */
  rateHz?: number;
  label?: string;
  className?: string;
}

const ZERO: JoystickVector = { x: 0, y: 0 };
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Normalise un déplacement (en pixels) depuis le centre : vecteur borné au cercle, zone morte appliquée. */
export function toVector(dx: number, dy: number, radius: number, deadZone: number): JoystickVector {
  if (radius <= 0) return ZERO;
  let x = dx / radius;
  let y = dy / radius;
  const length = Math.hypot(x, y);
  if (length > 1) {
    x /= length;
    y /= length;
  }
  if (Math.hypot(x, y) < deadZone) return ZERO;
  return { x: round(x), y: round(y) };
}

export function Joystick({
  onMove,
  size = 160,
  deadZone = 0.12,
  rateHz = 30,
  label = "Joystick",
  className,
}: JoystickProps) {
  const [knob, setKnob] = useState<JoystickVector>(ZERO);
  const lastSent = useRef(0);
  const lastVector = useRef<JoystickVector>(ZERO);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keys = useRef(new Set<string>());
  // Toujours la dernière version de `onMove`, sans réabonner les gestionnaires de pointeur.
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    onMoveRef.current = onMove;
  });
  const emit = (vector: JoystickVector) => onMoveRef.current(vector);

  const send = (vector: JoystickVector, force = false) => {
    setKnob(vector);
    lastVector.current = vector;
    const now = Date.now();
    const gap = 1000 / rateHz;
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    if (force || now - lastSent.current >= gap) {
      lastSent.current = now;
      emit(vector);
    } else {
      // Dernière position garantie même si le doigt s'arrête entre deux envois.
      pending.current = setTimeout(
        () => {
          lastSent.current = Date.now();
          pending.current = null;
          emit(lastVector.current);
        },
        gap - (now - lastSent.current),
      );
    }
  };

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const radius = rect.width / 2;
    send(toVector(e.clientX - rect.left - radius, e.clientY - rect.top - radius, radius, deadZone));
  };

  const fromKeys = () => {
    const k = keys.current;
    const x = (k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0);
    const y = (k.has("ArrowDown") ? 1 : 0) - (k.has("ArrowUp") ? 1 : 0);
    const length = Math.hypot(x, y) || 1;
    send({ x: round(x / length), y: round(y / length) }, true);
  };

  const knobSize = size * 0.42;
  return (
    <div
      role="application"
      aria-label={label}
      tabIndex={0}
      className={className}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        touchAction: "none",
        userSelect: "none",
        background: "rgba(127,127,127,0.18)",
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        fromPointer(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 0 || e.pointerType === "touch") fromPointer(e);
      }}
      onPointerUp={() => send(ZERO, true)}
      onPointerCancel={() => send(ZERO, true)}
      onKeyDown={(e) => {
        if (!e.key.startsWith("Arrow")) return;
        e.preventDefault();
        keys.current.add(e.key);
        fromKeys();
      }}
      onKeyUp={(e) => {
        if (!e.key.startsWith("Arrow")) return;
        keys.current.delete(e.key);
        fromKeys();
      }}
      onBlur={() => {
        keys.current.clear();
        if (lastVector.current !== ZERO) send(ZERO, true);
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          width: knobSize,
          height: knobSize,
          left: (size - knobSize) / 2,
          top: (size - knobSize) / 2,
          borderRadius: "50%",
          background: "currentColor",
          opacity: 0.8,
          transform: `translate(${knob.x * (size - knobSize) * 0.5}px, ${knob.y * (size - knobSize) * 0.5}px)`,
        }}
      />
    </div>
  );
}
