interface CacheEntry<V> {
  value: V;
  createdAt: number;
}

export class LRUCacheWithTTL<K, V> {
  private capacity: number;
  private ttlMs: number;
  private map: Map<K, CacheEntry<V>>;

  constructor(capacity: number, ttlMs: number) {
    if (capacity <= 0) throw new Error("capacity must be positive");
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  private isExpired(entry: CacheEntry<V>, nowMs: number): boolean {
    return nowMs - entry.createdAt > this.ttlMs;
  }

  public get(key: K, nowMs: number = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry, nowMs)) {
      this.map.delete(key);
      return undefined;
    }

    // Refresh LRU position (delete and re-insert)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  public put(key: K, value: V, nowMs: number = Date.now()): void {
    if (this.map.has(key)) {
      this.map.delete(key);
      this.map.set(key, { value, createdAt: nowMs });
      return;
    }

    // Purge any expired entries first
    for (const [k, entry] of this.map.entries()) {
      if (this.isExpired(entry, nowMs)) {
        this.map.delete(k);
      }
    }

    // If still at capacity, evict the least recently used entry (first in Map iteration)
    if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }

    this.map.set(key, { value, createdAt: nowMs });
  }

  public size(nowMs: number = Date.now()): number {
    for (const [k, entry] of this.map.entries()) {
      if (this.isExpired(entry, nowMs)) {
        this.map.delete(k);
      }
    }
    return this.map.size;
  }
}
