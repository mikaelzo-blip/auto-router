export interface ReservationResult {
  success: boolean;
  reservationId?: string;
  remaining: number;
  error?: string;
}

export class ReservationLockManager {
  private balances: Map<string, number> = new Map();
  private idempotencyStore: Map<string, ReservationResult> = new Map();
  private nextId = 1;

  public setBalance(resourceId: string, amount: number): void {
    this.balances.set(resourceId, amount);
  }

  public getBalance(resourceId: string): number {
    return this.balances.get(resourceId) ?? 0;
  }

  public async reserve(
    resourceId: string,
    amount: number,
    idempotencyKey: string
  ): Promise<ReservationResult> {
    // RACE CONDITION & CONCURRENCY FLAW:
    // Reads balance, awaits async I/O tick, then mutates balance without locking or mutual exclusion
    const current = this.getBalance(resourceId);

    // Simulated async storage latency
    await new Promise(r => setTimeout(r, 5));

    if (current < amount) {
      return { success: false, remaining: current, error: "INSUFFICIENT_BALANCE" };
    }

    const updated = current - amount;
    this.balances.set(resourceId, updated);

    const reservationId = `res_${this.nextId++}`;
    const result: ReservationResult = {
      success: true,
      reservationId,
      remaining: updated
    };

    this.idempotencyStore.set(idempotencyKey, result);
    return result;
  }
}
