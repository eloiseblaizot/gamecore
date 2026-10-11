/**
 * Rich Presence : ce que Discord affiche sous le nom du joueur pendant qu'il joue dans
 * l'Activity (« Buzzer ! — Question 3 / 5 — 1 200 points », temps restant, taille du groupe).
 *
 *   const presence = createPresence(session.sdk);
 *   presence.set({ details: "Question 3 / 5", state: "1 200 points", endsAt: deadline, party: { size: 3, max: 12 } });
 *
 * Discord limite le rythme des mises à jour : elles sont regroupées (au plus une toutes les
 * 4 s par défaut), et une présence identique à la précédente n'est pas renvoyée.
 *
 * ⚠️ Limites : la Rich Presence n'est possible que DANS une Activity (le SDK Discord parle au
 * client Discord) ; un site web ne peut pas modifier la présence d'un joueur. Elle demande la
 * portée OAuth `rpc.activities.write` (demandée par défaut par `startDiscordActivity`). Et
 * elle est visible par les amis du joueur : n'y mets jamais d'information secrète du jeu.
 */

import { sanitizeLine } from "@gamecore/core";

export interface Presence {
  /** Première ligne (ex. « Question 3 / 5 »). */
  details?: string;
  /** Seconde ligne (ex. « 1 200 points »). */
  state?: string;
  /** Début (horodatage ms) : Discord affiche le temps écoulé. */
  startedAt?: number;
  /** Fin prévue (horodatage ms) : Discord affiche le temps restant. */
  endsAt?: number;
  /** Taille du groupe : joueurs présents et maximum. */
  party?: { size: number; max: number; id?: string };
  /** Grande image : clé d'un « Rich Presence Asset » de l'application (ou URL https). */
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
}

/** L'activité au format du SDK Discord (`commands.setActivity`). */
export interface DiscordActivityPayload {
  type: 0;
  details?: string;
  state?: string;
  timestamps?: { start?: number; end?: number };
  party?: { id?: string; size: [number, number] };
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
}

/** Longueur max des textes de présence acceptée par Discord. */
const MAX_TEXT = 128;

const text = (value: string | undefined): string | undefined => sanitizeLine(value, MAX_TEXT) ?? undefined;
const asset = (value: string | undefined): string | undefined =>
  value && (/^[a-z0-9_-]{1,256}$/i.test(value) || value.startsWith("https://"))
    ? value.slice(0, 256)
    : undefined;
const time = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;

/** Convertit une présence en activité Discord : textes nettoyés et bornés, valeurs vérifiées. */
export function presenceActivity(presence: Presence): DiscordActivityPayload {
  const activity: DiscordActivityPayload = { type: 0 }; // 0 = « Joue à »
  const details = text(presence.details);
  const state = text(presence.state);
  if (details) activity.details = details;
  if (state) activity.state = state;
  const start = time(presence.startedAt);
  const end = time(presence.endsAt);
  if (start !== undefined || end !== undefined) activity.timestamps = { start, end };
  if (presence.party) {
    const max = Math.max(1, Math.floor(presence.party.max));
    const size = Math.min(max, Math.max(0, Math.floor(presence.party.size)));
    activity.party = {
      id: presence.party.id ? presence.party.id.slice(0, 128) : undefined,
      size: [size, max],
    };
  }
  const assets = {
    large_image: asset(presence.largeImage),
    large_text: text(presence.largeText),
    small_image: asset(presence.smallImage),
    small_text: text(presence.smallText),
  };
  if (Object.values(assets).some((v) => v !== undefined)) activity.assets = assets;
  return activity;
}

/** Ce dont on a besoin du SDK Discord pour la présence (remplaçable en test). */
export interface PresenceSdk {
  readonly commands: {
    setActivity(args: { activity: DiscordActivityPayload | null }): Promise<unknown>;
  };
}

export interface PresenceUpdater {
  /** Présence souhaitée (`null` : effacer). Appliquée au plus tôt, en respectant le rythme. */
  set(presence: Presence | null): void;
  /** Arrête les mises à jour (et efface la présence). */
  dispose(): void;
}

/** Crée un gestionnaire de présence qui regroupe les mises à jour. */
export function createPresence(sdk: PresenceSdk, options: { minIntervalMs?: number } = {}): PresenceUpdater {
  const minInterval = options.minIntervalMs ?? 4000;
  let wanted: string | null | undefined; // JSON de l'activité souhaitée (undefined : rien à faire)
  let sent: string | null | undefined;
  let lastSentAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = () => {
    timer = null;
    if (disposed || wanted === undefined || wanted === sent) return;
    sent = wanted;
    lastSentAt = Date.now();
    const activity = wanted === null ? null : (JSON.parse(wanted) as DiscordActivityPayload);
    sdk.commands.setActivity({ activity }).catch((err: unknown) => {
      // Portée refusée, client Discord ancien… : la présence est un bonus, le jeu continue.
      console.warn("[gamecore/discord] présence non mise à jour", err);
      sent = undefined;
    });
  };

  const schedule = () => {
    if (timer || disposed) return;
    const wait = Math.max(0, lastSentAt + minInterval - Date.now());
    timer = setTimeout(flush, wait);
  };

  return {
    set(presence) {
      if (disposed) return;
      wanted = presence === null ? null : JSON.stringify(presenceActivity(presence));
      if (wanted !== sent) schedule();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!disposed && sent) void sdk.commands.setActivity({ activity: null }).catch(() => undefined);
      disposed = true;
    },
  };
}
