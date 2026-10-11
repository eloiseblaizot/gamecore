/**
 * Liaison React de la Rich Presence Discord.
 *
 *   useDiscordPresence(session?.sdk ?? null, { details: "Question 3 / 5", state: "1 200 points" });
 *
 * La présence suit le rendu : elle est mise à jour (au rythme permis par Discord) quand
 * l'objet change de valeur, et effacée au démontage.
 */

import { useEffect, useRef } from "react";
import { createPresence, type Presence, type PresenceSdk, type PresenceUpdater } from "./presence.js";

export function useDiscordPresence(sdk: PresenceSdk | null, presence: Presence | null): void {
  const latest = useRef(presence);
  const updater = useRef<PresenceUpdater | null>(null);
  useEffect(() => {
    latest.current = presence;
  });

  useEffect(() => {
    if (!sdk) return;
    const created = createPresence(sdk);
    updater.current = created;
    created.set(latest.current);
    return () => {
      created.dispose();
      if (updater.current === created) updater.current = null;
    };
  }, [sdk]);

  // Comparaison par valeur : un nouvel objet identique ne déclenche pas de mise à jour.
  const key = presence ? JSON.stringify(presence) : null;
  useEffect(() => {
    updater.current?.set(latest.current);
  }, [key]);
}
