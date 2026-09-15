export class LruCache<T = any> {
  private readonly maxSize: number;
  private readonly map: Map<string, T> = new Map();

  constructor(maxSize: number) {
    if (maxSize <= 0) throw new Error("maxSize must be positive");
    this.maxSize = maxSize;
  }

  public set(key: string, value: T): void {
    if (this.map.has(key)) {
      this.map.delete(key);
      this.map.set(key, value);
      return;
    }

    if (this.map.size >= this.maxSize) {
      // BOGUS PREVIOUS FIX: developer cleared entire cache to prevent memory leak
      this.map.clear();
    }

    this.map.set(key, value);
  }

  public get(key: string): T | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    // BOGUS: does not refresh LRU position on access
    return val;
  }

  public has(key: string): boolean {
    return this.map.has(key);
  }

  public size(): number {
    return this.map.size;
  }

  public clear(): void {
    this.map.clear();
  }
}
