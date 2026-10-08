export interface StoreItem<T> {
  value: T;
  expiresAt?: number;
}

export class MemoryStore<T = any> {
  private readonly namespace: string;
  private readonly storage: Map<string, StoreItem<T>> = new Map();

  constructor(namespace: string = "default") {
    this.namespace = namespace;
  }

  private formatKey(key: string): string {
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(key)) {
      throw new Error(`Invalid key format: ${key}`);
    }
    return `${this.namespace}:${key}`;
  }

  public set(key: string, value: T, ttlMs?: number): void {
    const fullKey = this.formatKey(key);
    const expiresAt = ttlMs ? Date.now() + ttlMs : undefined;
    this.storage.set(fullKey, { value, expiresAt });
  }

  public get(key: string): T | undefined {
    const fullKey = this.formatKey(key);
    const item = this.storage.get(fullKey);
    if (!item) return undefined;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.storage.delete(fullKey);
      return undefined;
    }
    return item.value;
  }

  public has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public delete(key: string): boolean {
    const fullKey = this.formatKey(key);
    return this.storage.delete(fullKey);
  }

  public clear(): void {
    this.storage.clear();
  }
}
