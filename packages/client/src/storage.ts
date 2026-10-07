/**
 * Mémorisation de la session (jeton) pour retrouver sa place après un rechargement.
 *
 * Par défaut `sessionStorage` : propre à l'onglet, il survit au rechargement (le cas
 * courant sur téléphone, quand le navigateur recharge la page après une mise en veille)
 * mais pas à la fermeture de l'onglet. Deux onglets ont donc deux identités distinctes,
 * ce qui permet de tester à plusieurs sur un seul ordinateur.
 *
 * ⚠️ Le jeton donne accès à la place du joueur dans le salon : il ne doit jamais
 * apparaître dans une URL (historique, journaux de proxy, en-tête Referer).
 */

export interface SessionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface StoredSession {
  code: string;
  kind: "player" | "spectator" | "screen";
  /** Jeton de session (membre) ou d'administration (écran). */
  token: string | null;
}

/** Stockage en mémoire (tests, environnements sans `sessionStorage`). */
export function memoryStore(): SessionStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

/** `sessionStorage` du navigateur s'il est disponible (et autorisé), sinon `null`. */
export function browserSessionStore(): SessionStore | null {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return null;
    const probe = "__gamecore__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
    };
  } catch {
    // Navigation privée stricte, iframe sans stockage (Discord Activity…) : pas de mémorisation.
    return null;
  }
}

export function readSession(store: SessionStore | null, key: string): StoredSession | null {
  const raw = store?.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.code !== "string" || typeof parsed.kind !== "string") return null;
    if (parsed.token !== null && typeof parsed.token !== "string") return null;
    return { code: parsed.code, kind: parsed.kind, token: parsed.token ?? null };
  } catch {
    return null;
  }
}
