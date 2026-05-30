// Tiny in-memory TTL cache for lookup results, scoped to the worker lifetime.
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 200) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}
