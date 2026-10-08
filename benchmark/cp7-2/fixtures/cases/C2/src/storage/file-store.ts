export interface StoreItem<T> {
  value: T;
  expiresAt?: number;
}

export class FileStore<T = any> {
  private readonly namespace: string;
  private readonly memoryMirror: Map<string, string> = new Map();

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
    const raw = JSON.stringify({ value, expiresAt });
    this.memoryMirror.set(fullKey, raw);
  }

  public get(key: string): T | undefined {
    const fullKey = this.formatKey(key);
    const raw = this.memoryMirror.get(fullKey);
    if (!raw) return undefined;
    const item = JSON.parse(raw) as StoreItem<T>;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.memoryMirror.delete(fullKey);
      return undefined;
    }
    return item.value;
  }

  public has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public delete(key: string): boolean {
    const fullKey = this.formatKey(key);
    return this.memoryMirror.delete(fullKey);
  }

  public clear(): void {
    this.memoryMirror.clear();
  }
}
