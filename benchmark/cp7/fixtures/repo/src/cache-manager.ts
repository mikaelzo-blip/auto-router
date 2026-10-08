interface CacheEntry<T> {
  value: T;
  expiresAt?: number;
}

export class CacheManager<T = any> {
  private items: Map<string, CacheEntry<T>> = new Map();

  constructor(
    public readonly maxSize: number,
    public readonly defaultTtlMs?: number
  ) {
    if (maxSize <= 0) {
      throw new Error("maxSize must be greater than 0");
    }
  }

  get(key: string, now: number = Date.now()): T | undefined {
    const entry = this.items.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt && entry.expiresAt <= now) {
      this.items.delete(key);
      return undefined;
    }

    // Defect 1: Does not refresh LRU access order (should delete and re-insert into Map)
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number | undefined = this.defaultTtlMs, now: number = Date.now()): void {
    const expiresAt = ttlMs ? now + ttlMs : undefined;

    if (this.items.has(key)) {
      this.items.delete(key);
    }

    this.items.set(key, { value, expiresAt });

    if (this.items.size > this.maxSize) {
      // Step 1: Remove expired items
      for (const [k, entry] of Array.from(this.items.entries())) {
        if (entry.expiresAt && entry.expiresAt <= now) {
          this.items.delete(k);
        }
      }

      // Step 2: If still over maxSize, evict LRU
      // Defect 2: Pop removes the newest item instead of the oldest (shift)!
      if (this.items.size > this.maxSize) {
        const keys = Array.from(this.items.keys());
        const victim = keys.pop(); // BUG: should be keys.shift() or first key
        if (victim) {
          this.items.delete(victim);
        }
      }
    }
  }

  has(key: string, now: number = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}
