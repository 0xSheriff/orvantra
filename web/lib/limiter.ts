// In-memory sliding-window limiter (one per server process). Shared by the relay and the upload route.

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastPrune = 0;
  constructor(readonly limit: number, readonly windowMs: number) {}

  /** Number of keys currently remembered. */
  get size(): number {
    return this.hits.size;
  }

  /** Drops keys whose hits are all older than the window, so the map cannot grow without bound. */
  prune(now: number): void {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    this.lastPrune = now;
  }

  /** Records a hit and returns true when `key` is still under the limit. */
  take(key: string, now: number): boolean {
    if (now - this.lastPrune > Math.min(this.windowMs, 60_000)) this.prune(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/** Client IP: first hop of x-forwarded-for (Railway's proxy sets it), else "unknown". */
export function clientIp(headers: { get(name: string): string | null }): string {
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first ? first.slice(0, 64) : 'unknown';
}
