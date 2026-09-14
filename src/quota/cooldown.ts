export interface Classify429Result {
  is429: boolean;
  isQuotaExhaustion: boolean;
  isTemporaryRateLimit: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export function parseRetryAfter(headerValue?: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

export function classify429(
  status: number,
  body?: string | Record<string, unknown> | null,
  headers?: Headers | Record<string, string | undefined> | null
): Classify429Result {
  if (status !== 429 && status !== 403) {
    return {
      is429: false,
      isQuotaExhaustion: false,
      isTemporaryRateLimit: false
    };
  }

  let bodyStr = "";
  if (typeof body === "string") {
    bodyStr = body;
  } else if (body && typeof body === "object") {
    try {
      bodyStr = JSON.stringify(body);
    } catch {
      bodyStr = "";
    }
  }

  const headerRetry = headers instanceof Headers
    ? headers.get("retry-after")
    : (headers?.["retry-after"] ?? headers?.["Retry-After"]);

  const retryAfterMs = parseRetryAfter(headerRetry);

  const lower = bodyStr.toLowerCase();
  const quotaKeywords = [
    "quota",
    "insufficient_quota",
    "exceeded your current quota",
    "limit reached",
    "credit",
    "resource_exhausted",
    "billing"
  ];

  const hasQuotaKeyword = quotaKeywords.some((kw) => lower.includes(kw));

  if (hasQuotaKeyword) {
    return {
      is429: true,
      isQuotaExhaustion: true,
      isTemporaryRateLimit: false,
      retryAfterMs,
      reason: "quota_exhaustion"
    };
  }

  return {
    is429: true,
    isQuotaExhaustion: false,
    isTemporaryRateLimit: true,
    retryAfterMs,
    reason: "rate_limit"
  };
}

export interface CooldownEntry {
  modelOrGroup: string;
  type: "quota_exhaustion" | "rate_limit";
  expiresAt: number;
  reason?: string;
}

export interface CooldownTrackerOptions {
  defaultQuotaCooldownMs?: number;
  defaultRateLimitCooldownMs?: number;
}

export class QuotaCooldownTracker {
  private readonly defaultQuotaCooldownMs: number;
  private readonly defaultRateLimitCooldownMs: number;
  private readonly entries = new Map<string, CooldownEntry>();

  constructor(options: CooldownTrackerOptions = {}) {
    this.defaultQuotaCooldownMs = options.defaultQuotaCooldownMs ?? 300_000; // 5 min
    this.defaultRateLimitCooldownMs = options.defaultRateLimitCooldownMs ?? 15_000; // 15 sec
  }

  recordAccountResponse(
    accountAlias: string,
    modelOrGroup: string,
    status: number,
    body?: string | Record<string, unknown> | null,
    headers?: Headers | Record<string, string | undefined> | null
  ): void {
    const key = `${accountAlias}:${modelOrGroup}`;
    this.recordResponse(key, status, body, headers);
  }

  isAccountCooldownActive(
    accountAlias: string,
    modelOrGroup: string,
    now = Date.now()
  ): { active: boolean; type?: "quota_exhaustion" | "rate_limit"; remainingMs?: number; resetAt?: string } {
    const accountModel = this.isCooldownActive(`${accountAlias}:${modelOrGroup}`, now);
    if (accountModel.active) return accountModel;
    const accountGeneral = this.isCooldownActive(accountAlias, now);
    if (accountGeneral.active) return accountGeneral;
    return { active: false };
  }

  recordResponse(
    modelOrGroup: string,
    status: number,
    body?: string | Record<string, unknown> | null,
    headers?: Headers | Record<string, string | undefined> | null
  ): void {
    if (status !== 429 && status !== 403) {
      // 5xx, 401, 200 do not create quota cooldown
      return;
    }

    const classification = classify429(status, body, headers);
    if (!classification.is429) return;

    const durationMs = classification.retryAfterMs ?? (
      classification.isQuotaExhaustion
        ? this.defaultQuotaCooldownMs
        : this.defaultRateLimitCooldownMs
    );

    const expiresAt = Date.now() + durationMs;

    this.entries.set(modelOrGroup, {
      modelOrGroup,
      type: classification.isQuotaExhaustion ? "quota_exhaustion" : "rate_limit",
      expiresAt,
      reason: classification.reason
    });
  }

  isCooldownActive(
    modelOrGroup: string,
    now = Date.now()
  ): { active: boolean; type?: "quota_exhaustion" | "rate_limit"; remainingMs?: number; resetAt?: string } {
    const entry = this.entries.get(modelOrGroup);
    if (!entry) return { active: false };

    if (now >= entry.expiresAt) {
      this.entries.delete(modelOrGroup);
      return { active: false };
    }

    const remainingMs = entry.expiresAt - now;
    return {
      active: true,
      type: entry.type,
      remainingMs,
      resetAt: new Date(entry.expiresAt).toISOString()
    };
  }

  getActiveCooldowns(now = Date.now()): Record<string, { type: "quota_exhaustion" | "rate_limit"; remainingMs: number; resetAt: string; reason?: string }> {
    const result: Record<string, { type: "quota_exhaustion" | "rate_limit"; remainingMs: number; resetAt: string; reason?: string }> = {};
    for (const [key, entry] of this.entries.entries()) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
      } else {
        result[key] = {
          type: entry.type,
          remainingMs: entry.expiresAt - now,
          resetAt: new Date(entry.expiresAt).toISOString(),
          reason: entry.reason
        };
      }
    }
    return result;
  }

  clear(): void {
    this.entries.clear();
  }
}
