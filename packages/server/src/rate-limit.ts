/**
 * Limiteurs de débit.
 *
 * - `TokenBucket` : seau à jetons, pour le débit des messages d'une connexion. Le seau se
 *   remplit à `ratePerSecond` jetons par seconde jusqu'à `burst` ; chaque message en consomme un.
 * - `SlidingWindowCounter` : compte des événements par clé (adresse IP…) sur une fenêtre
 *   glissante, pour freiner la recherche de codes de salon par force brute.
 */

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly ratePerSecond: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(ratePerSecond: number, burst: number, now: () => number) {
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }

  /** Consomme `cost` jetons si possible ; renvoie faux si le débit est dépassé. */
  take(cost = 1): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export class SlidingWindowCounter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** Au-delà de ce nombre de clés suivies, on purge les clés inactives. */
  private readonly maxKeys: number;

  constructor(limit: number, windowMs: number, now: () => number, maxKeys = 10_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** Vrai si la clé a atteint la limite sur la fenêtre en cours. */
  isLimited(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  /** Enregistre un événement pour la clé. */
  record(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune();
  }

  /** Oublie les clés dont tous les événements sont sortis de la fenêtre. */
  prune(): void {
    for (const key of [...this.hits.keys()]) {
      if (this.recent(key).length === 0) this.hits.delete(key);
    }
  }

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length > 0) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }
}
