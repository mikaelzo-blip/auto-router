export class SlidingWindowRateLimiter {
  private requests: Map<string, number[]> = new Map();

  constructor(
    public readonly windowMs: number,
    public readonly maxRequests: number
  ) {
    if (windowMs <= 0 || maxRequests <= 0) {
      throw new Error("windowMs and maxRequests must be positive numbers");
    }
  }

  isAllowed(key: string, now: number = Date.now()): boolean {
    const list = this.requests.get(key) || [];
    const windowStart = now - this.windowMs;

    // Defect: Only prunes when the unpruned list exceeds maxRequests,
    // and retains timestamps <= windowStart due to faulty comparison (>= windowStart).
    // This leaks memory and rejects valid requests that arrive after window expiration.
    const active = list.filter(ts => ts >= windowStart);

    if (active.length >= this.maxRequests) {
      this.requests.set(key, active);
      return false;
    }

    active.push(now);
    this.requests.set(key, active);
    return true;
  }

  getRemainingRequests(key: string, now: number = Date.now()): number {
    const list = this.requests.get(key) || [];
    const windowStart = now - this.windowMs;
    const active = list.filter(ts => ts > windowStart);
    return Math.max(0, this.maxRequests - active.length);
  }

  reset(key?: string): void {
    if (key) {
      this.requests.delete(key);
    } else {
      this.requests.clear();
    }
  }
}
