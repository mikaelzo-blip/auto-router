export type QuotaPolicy = "off" | "shadow" | "auto";

export type CandidateQuotaStatus = "healthy" | "conserve" | "reserve" | "exhausted" | "unknown";

export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable";

export interface QuotaBucket {
  id: string;
  provider: string;
  scope: string;
  used: number;
  limit: number;
  remaining: number;
  remainingRatio: number;
  resetAt: string | null;
  observedAt: string;
  stale: boolean;
}

export interface AccountQuotaState {
  accountAlias: string;
  status: CandidateQuotaStatus;
  effectiveRemainingRatio: number;
  limitingBuckets: string[];
  resetAt: string | null;
  providerHealth: ProviderHealthStatus;
}

export interface CandidateQuotaPoolState {
  status: CandidateQuotaStatus;
  bestRemainingRatio: number;
  usableAccountCount: number;
  totalAccountCount: number;
  constrainedAccountCount: number;
  exhaustedAccountCount: number;
  earliestRelevantReset: string | null;
  accounts?: AccountQuotaState[];
}

export interface CandidateQuotaState {
  status: CandidateQuotaStatus;
  effectiveRemainingRatio: number;
  limitingBuckets: string[];
  resetAt: string | null;
  sourceFreshness: {
    snapshotAgeMs: number;
    stale: boolean;
  };
  reason?: string;
  pool?: CandidateQuotaPoolState;
}

export interface AccountQuotaSnapshot {
  accountAlias: string;
  provider: string;
  providerHealth: ProviderHealthStatus;
  buckets: Record<string, QuotaBucket>;
  isActive?: boolean;
}

export interface QuotaSnapshot {
  observedAt: number;
  buckets: Record<string, QuotaBucket>;
  providerHealth: Record<string, ProviderHealthStatus>;
  stale: boolean;
  accounts?: Record<string, AccountQuotaSnapshot>;
  accountPools?: Record<string, CandidateQuotaPoolState>;
}

export interface QuotaThresholds {
  healthyMin: number; // default 0.30 (remaining > 30%)
  conserveMin: number; // default 0.10 (remaining > 10% and <= 30%)
  conserveExit?: number; // hysteresis exit threshold, e.g. 0.30
  reserveExit?: number; // hysteresis exit threshold, e.g. 0.12
}

export interface QuotaConfig {
  policy: QuotaPolicy;
  refreshTtlMs: number;
  staleFallbackMs: number;
  timeoutMs: number;
  thresholds: QuotaThresholds;
}

export interface QuotaSource {
  getSnapshot(): Promise<QuotaSnapshot>;
  close(): void;
}

export interface QuotaDecision {
  policy: QuotaPolicy;
  status: CandidateQuotaStatus;
  effectiveRemainingRatio: number;
  limitingBuckets: string[];
  snapshotAgeMs: number;
  stale: boolean;
  selectionEffect: string;
  decisionReason?: string;
  candidateStates: Record<string, CandidateQuotaState>;
  hypotheticalProfile?: string;
  hypotheticalModel?: string;
  wouldSwitch?: boolean;
  switchReason?: string;
}
