export class TokenBucket {
  private capacity: number;
  private refillRatePerSec: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(capacity: number, refillRatePerSec: number) {
    this.capacity = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.tokens = capacity;
    this.lastRefillMs = 0;
  }

  private refill(nowMs: number): void {
    if (this.lastRefillMs === 0) {
      this.lastRefillMs = nowMs;
      return;
    }
    if (nowMs > this.lastRefillMs) {
      const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
      this.lastRefillMs = nowMs;
    }
  }

  public consume(tokens: number, nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  public getTokens(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }
}
