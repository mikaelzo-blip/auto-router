import type { QuotaBucket, QuotaSnapshot, QuotaSource, ProviderHealthStatus, AccountQuotaSnapshot } from "./types.js";

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]!, idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface NineRouterQuotaSourceOptions {
  baseUrl: string;
  refreshTtlMs?: number;
  staleFallbackMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class NineRouterQuotaSource implements QuotaSource {
  private readonly baseUrl: string;
  private readonly refreshTtlMs: number;
  private readonly staleFallbackMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private cachedSnapshot: QuotaSnapshot | null = null;
  private inFlightRefresh: Promise<QuotaSnapshot> | null = null;
  private isClosed = false;

  constructor(options: NineRouterQuotaSourceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.refreshTtlMs = options.refreshTtlMs ?? 30_000;
    this.staleFallbackMs = options.staleFallbackMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getSnapshot(): Promise<QuotaSnapshot> {
    const now = Date.now();

    if (this.cachedSnapshot) {
      const age = now - this.cachedSnapshot.observedAt;
      if (age < this.refreshTtlMs) {
        return {
          ...this.cachedSnapshot,
          stale: false
        };
      }

      // If within stale fallback window, serve stale while triggering background refresh
      if (age < this.staleFallbackMs) {
        if (!this.inFlightRefresh) {
          this.inFlightRefresh = this.fetchFromUpstream()
            .then((fresh) => {
              this.cachedSnapshot = fresh;
              return fresh;
            })
            .catch(() => this.cachedSnapshot!)
            .finally(() => {
              this.inFlightRefresh = null;
            });
        }
        return {
          ...this.cachedSnapshot,
          stale: true
        };
      }
    }

    // Cache is missing or expired beyond stale fallback window: fetch synchronously with bounded timeout
    if (!this.inFlightRefresh) {
      this.inFlightRefresh = this.fetchFromUpstream()
        .then((fresh) => {
          this.cachedSnapshot = fresh;
          return fresh;
        })
        .catch((error) => {
          // If we had a stale snapshot, return it marked stale rather than failing completely
          if (this.cachedSnapshot) {
            return {
              ...this.cachedSnapshot,
              stale: true
            };
          }
          // Fail open to unknown
          const emptySnapshot: QuotaSnapshot = {
            observedAt: now,
            buckets: {},
            providerHealth: {
              antigravity: "unavailable",
              codex: "unavailable"
            },
            stale: true
          };
          return emptySnapshot;
        })
        .finally(() => {
          this.inFlightRefresh = null;
        });
    }

    return this.inFlightRefresh;
  }

  private async fetchFromUpstream(): Promise<QuotaSnapshot> {
    const now = Date.now();
    const observedAtIso = new Date(now).toISOString();

    const providerHealth: Record<string, ProviderHealthStatus> = {
      antigravity: "healthy",
      codex: "healthy"
    };

    let connections: Array<{ id: string; provider: string; isActive?: boolean; testStatus?: string }> = [];

    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const res = await this.fetchImpl(`${this.baseUrl}/api/providers`, { signal });
      if (!res.ok) {
        throw new Error(`providers endpoint status ${res.status}`);
      }
      const data = await res.json() as { connections?: Array<{ id: string; provider: string; isActive?: boolean; testStatus?: string }> };
      connections = (data.connections ?? []).filter((c) => c.isActive !== false);
    } catch {
      providerHealth.antigravity = "unavailable";
      providerHealth.codex = "unavailable";
      return {
        observedAt: now,
        buckets: {},
        providerHealth,
        stale: false
      };
    }

    const buckets: Record<string, QuotaBucket> = {};
    const accounts: Record<string, AccountQuotaSnapshot> = {};

    // Group connections by provider and sort deterministically
    const activeAgConnections = connections
      .filter((c) => c.provider === "antigravity")
      .sort((a, b) => {
        const pA = (a as any).priority ?? 999;
        const pB = (b as any).priority ?? 999;
        if (pA !== pB) return pA - pB;
        return a.id.localeCompare(b.id);
      });

    const activeCxConnections = connections
      .filter((c) => c.provider === "codex")
      .sort((a, b) => {
        const pA = (a as any).priority ?? 999;
        const pB = (b as any).priority ?? 999;
        if (pA !== pB) return pA - pB;
        return a.id.localeCompare(b.id);
      });

    if (activeAgConnections.length === 0) {
      providerHealth.antigravity = "unavailable";
    }
    if (activeCxConnections.length === 0) {
      providerHealth.codex = "unavailable";
    }

    let agFetchSuccess = false;
    let cxFetchSuccess = false;

    // Fetch usage for active Antigravity connections with bounded concurrency
    await mapConcurrent(activeAgConnections, 4, async (conn, idx) => {
      const accountAlias = `account_${idx + 1}`;
      const accountBuckets: Record<string, QuotaBucket> = {};

      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        const res = await this.fetchImpl(`${this.baseUrl}/api/usage/${conn.id}`, { signal });
        if (!res.ok) {
          accounts[`antigravity:${accountAlias}`] = {
            accountAlias,
            provider: "antigravity",
            providerHealth: "degraded",
            buckets: {},
            isActive: true
          };
          return;
        }

        const usage = await res.json() as {
          quotas?: Record<string, {
            used?: number;
            total?: number;
            remaining?: number;
            remainingPercentage?: number;
            resetAt?: string | null;
            unlimited?: boolean;
            displayName?: string;
          }>;
        };

        if (usage.quotas) {
          agFetchSuccess = true;

          // 1. Group Gemini Flash / Pro models (excluding image)
          const geminiEntries = Object.entries(usage.quotas)
            .filter(([key]) => key.startsWith("gemini-") && !key.includes("image"));

          if (geminiEntries.length > 0) {
            const minGeminiEntry = geminiEntries.reduce((min, curr) => {
              const minRatio = min[1].remainingPercentage !== undefined
                ? min[1].remainingPercentage / 100
                : (min[1].remaining !== undefined && (min[1].total ?? 1000) > 0)
                  ? min[1].remaining / (min[1].total ?? 1000)
                  : 1.0;
              const currRatio = curr[1].remainingPercentage !== undefined
                ? curr[1].remainingPercentage / 100
                : (curr[1].remaining !== undefined && (curr[1].total ?? 1000) > 0)
                  ? curr[1].remaining / (curr[1].total ?? 1000)
                  : 1.0;
              return currRatio < minRatio ? curr : min;
            });

            const q = minGeminiEntry[1];
            const limit = q.total ?? 1000;
            const used = q.used ?? 0;
            let ratio = q.remainingPercentage !== undefined
              ? q.remainingPercentage / 100
              : q.remaining !== undefined && limit > 0
                ? q.remaining / limit
                : 1.0;
            ratio = Math.max(0, Math.min(1, ratio));
            const remaining = q.remaining ?? Math.round(limit * ratio);

            accountBuckets["gemini_flash_pro"] = {
              id: "gemini_flash_pro",
              provider: "antigravity",
              scope: "model_shared",
              used,
              limit,
              remaining,
              remainingRatio: ratio,
              resetAt: q.resetAt ?? null,
              observedAt: observedAtIso,
              stale: false
            };
          }

          // 2. Weekly quota bucket
          const weekly = usage.quotas["gemini_weekly"] ?? usage.quotas["gemini-3.8-flash-high"];
          if (weekly) {
            const limit = weekly.total ?? 1000;
            const used = weekly.used ?? 0;
            let ratio = weekly.remainingPercentage !== undefined
              ? weekly.remainingPercentage / 100
              : weekly.remaining !== undefined && limit > 0
                ? weekly.remaining / limit
                : 1.0;
            ratio = Math.max(0, Math.min(1, ratio));
            const remaining = weekly.remaining ?? Math.round(limit * ratio);

            accountBuckets["gemini_weekly"] = {
              id: "gemini_weekly",
              provider: "antigravity",
              scope: "weekly",
              used,
              limit,
              remaining,
              remainingRatio: ratio,
              resetAt: weekly.resetAt ?? null,
              observedAt: observedAtIso,
              stale: false
            };
          }

          // Ensure bidirectional presence if only one was parsed
          if (!accountBuckets["gemini_weekly"] && accountBuckets["gemini_flash_pro"]) {
            const b = accountBuckets["gemini_flash_pro"]!;
            accountBuckets["gemini_weekly"] = {
              ...b,
              id: "gemini_weekly",
              scope: "weekly"
            };
          } else if (!accountBuckets["gemini_flash_pro"] && accountBuckets["gemini_weekly"]) {
            const b = accountBuckets["gemini_weekly"]!;
            accountBuckets["gemini_flash_pro"] = {
              ...b,
              id: "gemini_flash_pro",
              scope: "model_shared"
            };
          }

          // Update legacy / pooled buckets
          for (const [bId, bVal] of Object.entries(accountBuckets)) {
            const existing = buckets[bId];
            if (!existing || bVal.remainingRatio > existing.remainingRatio) {
              buckets[bId] = bVal;
            }
          }

          accounts[`antigravity:${accountAlias}`] = {
            accountAlias,
            provider: "antigravity",
            providerHealth: conn.testStatus === "unavailable" ? "unavailable" : "healthy",
            buckets: accountBuckets,
            isActive: true
          };
        }
      } catch {
        accounts[`antigravity:${accountAlias}`] = {
          accountAlias,
          provider: "antigravity",
          providerHealth: "degraded",
          buckets: {},
          isActive: true
        };
      }
    });

    // Fetch usage for active Codex connections with bounded concurrency
    await mapConcurrent(activeCxConnections, 4, async (conn, idx) => {
      const accountAlias = `account_${idx + 1}`;
      const accountBuckets: Record<string, QuotaBucket> = {};

      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        const res = await this.fetchImpl(`${this.baseUrl}/api/usage/${conn.id}`, { signal });
        if (!res.ok) {
          accounts[`codex:${accountAlias}`] = {
            accountAlias,
            provider: "codex",
            providerHealth: "degraded",
            buckets: {},
            isActive: true
          };
          return;
        }

        const usage = await res.json() as {
          limitReached?: boolean;
          quotas?: {
            session?: { used?: number; total?: number; remaining?: number; resetAt?: string | null };
            weekly?: { used?: number; total?: number; remaining?: number; resetAt?: string | null };
          };
        };

        if (usage.quotas) {
          cxFetchSuccess = true;
          if (usage.quotas.session) {
            const q = usage.quotas.session;
            const limit = q.total ?? 100;
            const used = q.used ?? 0;
            let remaining = usage.limitReached ? 0 : (q.remaining ?? (limit - used));
            let ratio = limit > 0 ? remaining / limit : 1.0;
            ratio = Math.max(0, Math.min(1, ratio));

            accountBuckets["codex_session"] = {
              id: "codex_session",
              provider: "codex",
              scope: "session",
              used,
              limit,
              remaining,
              remainingRatio: ratio,
              resetAt: q.resetAt ?? null,
              observedAt: observedAtIso,
              stale: false
            };
          }

          if (usage.quotas.weekly) {
            const q = usage.quotas.weekly;
            const limit = q.total ?? 100;
            const used = q.used ?? 0;
            let remaining = usage.limitReached ? 0 : (q.remaining ?? (limit - used));
            let ratio = limit > 0 ? remaining / limit : 1.0;
            ratio = Math.max(0, Math.min(1, ratio));

            accountBuckets["codex_weekly"] = {
              id: "codex_weekly",
              provider: "codex",
              scope: "weekly",
              used,
              limit,
              remaining,
              remainingRatio: ratio,
              resetAt: q.resetAt ?? null,
              observedAt: observedAtIso,
              stale: false
            };
          }

          for (const [bId, bVal] of Object.entries(accountBuckets)) {
            const existing = buckets[bId];
            if (!existing || bVal.remainingRatio > existing.remainingRatio) {
              buckets[bId] = bVal;
            }
          }

          accounts[`codex:${accountAlias}`] = {
            accountAlias,
            provider: "codex",
            providerHealth: conn.testStatus === "unavailable" ? "unavailable" : "healthy",
            buckets: accountBuckets,
            isActive: true
          };
        }
      } catch {
        accounts[`codex:${accountAlias}`] = {
          accountAlias,
          provider: "codex",
          providerHealth: "degraded",
          buckets: {},
          isActive: true
        };
      }
    });

    if (activeAgConnections.length > 0 && !agFetchSuccess) {
      providerHealth.antigravity = "degraded";
    }
    if (activeCxConnections.length > 0 && !cxFetchSuccess) {
      providerHealth.codex = "degraded";
    }

    return {
      observedAt: now,
      buckets,
      providerHealth,
      stale: false,
      accounts
    };
  }

  close(): void {
    this.isClosed = true;
    this.inFlightRefresh = null;
    this.cachedSnapshot = null;
  }
}

export class SyntheticQuotaSource implements QuotaSource {
  private snapshot: QuotaSnapshot;

  constructor(initialSnapshot?: Partial<QuotaSnapshot>) {
    this.snapshot = {
      observedAt: initialSnapshot?.observedAt ?? Date.now(),
      buckets: initialSnapshot?.buckets ?? {},
      providerHealth: initialSnapshot?.providerHealth ?? {
        antigravity: "healthy",
        codex: "healthy"
      },
      stale: initialSnapshot?.stale ?? false
    };
  }

  setBucket(bucket: QuotaBucket): void {
    this.snapshot.buckets[bucket.id] = bucket;
    this.snapshot.observedAt = Date.now();
  }

  setProviderHealth(provider: string, status: ProviderHealthStatus): void {
    this.snapshot.providerHealth[provider] = status;
  }

  setStale(stale: boolean): void {
    this.snapshot.stale = stale;
  }

  setSnapshot(snapshot: QuotaSnapshot): void {
    this.snapshot = snapshot;
  }

  setAccount(account: AccountQuotaSnapshot): void {
    if (!this.snapshot.accounts) {
      this.snapshot.accounts = {};
    }
    this.snapshot.accounts[`${account.provider}:${account.accountAlias}`] = account;
    this.snapshot.observedAt = Date.now();
  }

  setAccounts(accounts: Record<string, AccountQuotaSnapshot>): void {
    this.snapshot.accounts = { ...accounts };
    this.snapshot.observedAt = Date.now();
  }

  async getSnapshot(): Promise<QuotaSnapshot> {
    return {
      ...this.snapshot,
      buckets: { ...this.snapshot.buckets },
      providerHealth: { ...this.snapshot.providerHealth },
      ...(this.snapshot.accounts ? { accounts: { ...this.snapshot.accounts } } : {})
    };
  }

  close(): void {
    // no-op
  }
}
