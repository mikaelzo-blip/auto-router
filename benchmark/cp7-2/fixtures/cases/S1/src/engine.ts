export interface Account {
  id: string;
  balanceCents: number;
}

export interface LedgerEntry {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  timestamp: number;
}

export class TransactionEngine {
  private accounts: Map<string, Account> = new Map();
  private ledger: LedgerEntry[] = [];
  private nextEntryId = 1;

  public createAccount(id: string, initialBalanceCents: number): void {
    this.accounts.set(id, { id, balanceCents: initialBalanceCents });
  }

  public getAccount(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  public getLedger(): LedgerEntry[] {
    return [...this.ledger];
  }

  public transfer(fromId: string, toId: string, amountCents: number): { success: boolean; error?: string } {
    const from = this.accounts.get(fromId);
    const to = this.accounts.get(toId);

    if (!from || !to) return { success: false, error: "ACCOUNT_NOT_FOUND" };
    if (from.balanceCents < amountCents) return { success: false, error: "INSUFFICIENT_FUNDS" };

    // FLAW: Mutates balance before recording ledger; if ledger fails, state is corrupted
    from.balanceCents -= amountCents;
    to.balanceCents += amountCents;

    // Simulate ledger failure on amounts ending in 99
    if (amountCents % 100 === 99) {
      throw new Error("Ledger storage write rejected");
    }

    this.ledger.push({
      id: `entry_${this.nextEntryId++}`,
      fromAccountId: fromId,
      toAccountId: toId,
      amountCents,
      timestamp: Date.now()
    });

    return { success: true };
  }
}
