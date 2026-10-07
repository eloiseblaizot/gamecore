/** Émetteur d'évènements minimal et typé. */

export type Listener<Args extends unknown[]> = (...args: Args) => void;

export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = (this.listeners[event] ??= new Set<Listener<Events[K]>>());
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const listener of [...(this.listeners[event] ?? [])]) {
      try {
        listener(...args);
      } catch (err) {
        // Un écouteur défaillant ne doit pas empêcher les autres d'être prévenus.
        console.error("[gamecore] erreur dans un écouteur", err);
      }
    }
  }

  clear(): void {
    for (const key of Object.keys(this.listeners)) delete this.listeners[key as keyof Events];
  }
}
