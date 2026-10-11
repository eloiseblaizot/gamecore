/**
 * Liaisons React du moteur audio.
 *
 *   <AudioProvider engine={audio}>…</AudioProvider>
 *   useMusicMood("game");                 // ambiance tant que le composant est affiché
 *   const play = useSfx(); play("success");
 *   <SoundControls />                     // bouton 🔊 : volumes musique / effets, coupure
 */

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { DEFAULT_SOUND, type AudioEngine, type SoundSettings } from "./engine.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEngine = AudioEngine<any, any>;

const EngineContext = createContext<AnyEngine | null>(null);

/** Le champ actif attend-il une saisie (on ne détourne pas la touche M) ? */
const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
};

export interface AudioProviderProps {
  engine: AnyEngine;
  children: ReactNode;
  /** Touche qui coupe / rétablit le son (« m » par défaut, `null` pour aucune). */
  muteKey?: string | null;
  /** Petit clic sonore sur les éléments qui correspondent (ex. « button »), aucun par défaut. */
  clickSelector?: string;
}

/**
 * Branche le son sur l'application : déblocage au premier geste (règle des navigateurs),
 * touche M pour tout couper, silence quand l'onglet passe en arrière-plan.
 */
export function AudioProvider({ engine, children, muteKey = "m", clickSelector }: AudioProviderProps) {
  useEffect(() => {
    const unlock = () => engine.unlock();
    const onKey = (e: KeyboardEvent) => {
      if (
        !muteKey ||
        e.key.toLowerCase() !== muteKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        isTyping(e.target)
      ) {
        return;
      }
      engine.toggleMute();
    };
    const onClick = (e: MouseEvent) => {
      if (!clickSelector) return;
      const el = (e.target as Element | null)?.closest?.(clickSelector);
      if (el && !(el as HTMLButtonElement).disabled) engine.play("click");
    };
    const onVisibility = () => engine.setHidden(document.visibilityState === "hidden");
    onVisibility();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    window.addEventListener("touchend", unlock, true);
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      window.removeEventListener("touchend", unlock, true);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [engine, muteKey, clickSelector]);

  return <EngineContext value={engine}>{children}</EngineContext>;
}

/** Le moteur audio du `AudioProvider` le plus proche. */
export function useAudio<E extends AnyEngine = AnyEngine>(): E {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("useAudio doit être utilisé sous un <AudioProvider>.");
  return engine as E;
}

/** Réglages du son (se met à jour quand ils changent). */
export function useSoundSettings(): SoundSettings {
  const engine = useAudio();
  return useSyncExternalStore(engine.subscribe, engine.getSettings, () => DEFAULT_SOUND);
}

/** Fonction pour jouer un bruitage. */
export function useSfx<E extends AnyEngine = AnyEngine>(): E["play"] {
  const engine = useAudio<E>();
  return ((name, options) => engine.play(name, options)) as E["play"];
}

/**
 * Choisit l'ambiance musicale tant que le composant est affiché. Au démontage, la musique
 * s'arrête si c'est toujours cette ambiance qui joue.
 */
export function useMusicMood(mood: string | null): void {
  const engine = useAudio();
  useEffect(() => {
    engine.setMood(mood);
    return () => {
      if (engine.currentMood === mood) engine.setMood(null);
    };
  }, [engine, mood]);
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const id = useId();
  return (
    <div className="gc-sound-slider">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(value * 100)}
        aria-valuetext={`${Math.round(value * 100)} %`}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
    </div>
  );
}

/**
 * Bouton 🔊 avec volumes musique / effets séparés et coupure générale. Non stylé (classes
 * `gc-sound*`) : chaque jeu l'habille à sa façon.
 */
export function SoundControls({ className }: { className?: string }) {
  const engine = useAudio();
  const s = useSoundSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const silent = s.muted || (s.music === 0 && s.sfx === 0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={["gc-sound", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="gc-sound-toggle"
        aria-label={silent ? "Son coupé : ouvrir les réglages du son" : "Réglages du son"}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden>{silent ? "🔇" : "🔊"}</span>
      </button>
      {open && (
        <div id={panelId} role="group" aria-label="Réglages du son" className="gc-sound-panel">
          <Slider
            label="🎵 Musique"
            value={s.music}
            onChange={(music) => engine.setSettings({ music, muted: false })}
          />
          <Slider
            label="✨ Effets"
            value={s.sfx}
            onChange={(sfx) => engine.setSettings({ sfx, muted: false })}
          />
          <button type="button" className="gc-sound-mute" onClick={() => engine.toggleMute()}>
            {s.muted ? "🔊 Réactiver le son" : "🔇 Tout couper"}
          </button>
          <p className="gc-sound-hint">
            Raccourci : touche <kbd>M</kbd>. La musique baisse toute seule quand quelqu'un parle.
          </p>
        </div>
      )}
    </div>
  );
}
