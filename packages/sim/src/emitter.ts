/** Émetteur d'événements minimal et typé (même contrat que celui de @gamecore/client). */

export type Listener<Args extends unknown[]> = (...args: Args) => void;

export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Vrai si quelqu'un écoute `event` (évite de préparer des données pour personne). */
  has(event: keyof Events): boolean {
    return (this.listeners.get(event)?.size ?? 0) > 0;
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set] as Listener<Events[K]>[]) {
      try {
        listener(...args);
      } catch (err) {
        // Un écouteur défaillant ne doit pas empêcher les autres d'être prévenus.
        console.error("[gamecore] erreur dans un écouteur", err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
