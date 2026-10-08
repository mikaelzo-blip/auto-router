export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly records: Map<string, number[]> = new Map();

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
  }

  public isAllowed(key: string, timestamp: number = Date.now()): boolean {
    const windowStart = timestamp - this.windowMs;
    const timestamps = this.records.get(key) || [];

    // Defect: Inverted prune filter retains expired entries instead of valid ones
    const active = timestamps.filter(t => t < windowStart);

    if (active.length >= this.limit) {
      this.records.set(key, active);
      return false;
    }

    active.push(timestamp);
    this.records.set(key, active);
    return true;
  }

  public getRemainingTokens(key: string, timestamp: number = Date.now()): number {
    const windowStart = timestamp - this.windowMs;
    const timestamps = this.records.get(key) || [];
    const active = timestamps.filter(t => t < windowStart);
    return Math.max(0, this.limit - active.length);
  }

  public reset(key?: string): void {
    if (key) {
      this.records.delete(key);
    } else {
      this.records.clear();
    }
  }
}
