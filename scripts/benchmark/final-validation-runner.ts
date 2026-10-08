import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { NineRouterQuotaSource } from "../../src/quota/source.js";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

export const EVALUATOR_VERSION = "final-val-1.0.0";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface StrongTaskResult {
  taskId: string;
  category: "STRONG";
  taskName: string;
  modelId: string;
  modelAlias: string;
  timestamp: string;
  operationalSuccess: boolean;
  qualitySuccess: boolean;
  correct: boolean;
  criticalOmissions: string[];
  hallucinations: string[];
  constraintFailures: string[];
  score: number;
  elapsedMs: number;
  ttfbMs: number;
  usage?: TokenUsage;
  rawResponse: string;
}

export interface AgenticTaskResult {
  taskId: string;
  category: "AGENTIC";
  taskName: string;
  modelId: string;
  modelAlias: string;
  timestamp: string;
  operationalSuccess: boolean;
  qualitySuccess: boolean;
  finalTestsGreen: boolean;
  hiddenTestsGreen: boolean;
  iterations: number;
  toolCalls: number;
  failedToolCalls: number;
  timeoutOrError?: string;
  prematureSuccess: boolean;
  elapsedMs: number;
  ttfbMs: number;
  score: number;
  filesChanged: string[];
  publicOutputSnippet: string;
  hiddenOutputSnippet: string;
}

export function isPathInside(baseDir: string, targetPath: string): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function isWritableSourcePath(workDir: string, targetPath: string): boolean {
  const resolvedWorkDir = resolve(workDir);
  const resolvedTarget = resolve(resolvedWorkDir, targetPath);
  const rel = relative(resolvedWorkDir, resolvedTarget).replace(/\\/g, "/");
  if (rel.startsWith("test/") || rel === "test" || rel.startsWith("test-hidden/") || rel === "package.json" || rel.includes("..")) {
    return false;
  }
  return isPathInside(resolve(resolvedWorkDir, "src"), resolvedTarget);
}

export function createAgenticTools() {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the full contents of a file in the workspace",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to file relative to repo root" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file (restricted to src/)",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to file relative to repo root" },
            content: { type: "string", description: "Full content to write" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "patch_file",
        description: "Perform exact string replacement in a file (restricted to src/)",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to file relative to repo root" },
            old_string: { type: "string", description: "Exact text to find" },
            new_string: { type: "string", description: "Replacement text" }
          },
          required: ["path", "old_string", "new_string"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_tests",
        description: "Run the visible test suite for the current task",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a directory",
        parameters: {
          type: "object",
          properties: {
            dir: { type: "string", description: "Directory to list, default: ." }
          }
        }
      }
    }
  ];
}

export function executeAgenticTool(
  workDir: string,
  testTarget: string,
  name: string,
  args: any,
  changedFiles: Set<string>,
  prohibitedFiles: Set<string>
): { result: string; success: boolean; prohibitedWrite?: boolean } {
  try {
    if (name === "read_file") {
      if (!isPathInside(workDir, args.path)) {
        return { result: "Error: Access outside repository denied", success: false };
      }
      const fullPath = resolve(workDir, args.path);
      if (!existsSync(fullPath)) {
        return { result: `Error: File not found: ${args.path}`, success: false };
      }
      const content = readFileSync(fullPath, "utf-8");
      return { result: content, success: true };
    }

    if (name === "write_file") {
      if (!isPathInside(workDir, args.path)) {
        return { result: "Error: Access outside repository denied", success: false };
      }
      if (!isWritableSourcePath(workDir, args.path)) {
        prohibitedFiles.add(args.path);
        return {
          result: "Error: Writes are restricted to source files under src/; tests and metadata are immutable",
          success: false,
          prohibitedWrite: true
        };
      }
      const fullPath = resolve(workDir, args.path);
      const parentDir = resolve(fullPath, "..");
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(fullPath, args.content, "utf-8");
      changedFiles.add(args.path);
      return { result: `Successfully wrote ${args.path}`, success: true };
    }

    if (name === "patch_file") {
      if (!isPathInside(workDir, args.path)) {
        return { result: "Error: Access outside repository denied", success: false };
      }
      if (!isWritableSourcePath(workDir, args.path)) {
        prohibitedFiles.add(args.path);
        return {
          result: "Error: Patches are restricted to source files under src/; tests and metadata are immutable",
          success: false,
          prohibitedWrite: true
        };
      }
      const fullPath = resolve(workDir, args.path);
      if (!existsSync(fullPath)) {
        return { result: `Error: File not found: ${args.path}`, success: false };
      }
      const content = readFileSync(fullPath, "utf-8");
      const occurrences = content.split(args.old_string).length - 1;
      if (occurrences === 0) {
        return { result: `Error: old_string not found in ${args.path}`, success: false };
      }
      if (occurrences !== 1) {
        return { result: `Error: old_string must be unique in ${args.path}`, success: false };
      }
      const newContent = content.replace(args.old_string, args.new_string);
      writeFileSync(fullPath, newContent, "utf-8");
      changedFiles.add(args.path);
      return { result: `Successfully patched ${args.path}`, success: true };
    }

    if (name === "run_tests") {
      const fullTestPath = resolve(workDir, testTarget);
      try {
        const out = execSync(`node --import tsx --test ${fullTestPath}`, {
          cwd: workDir,
          encoding: "utf-8",
          timeout: 10000
        });
        return { result: `TESTS PASSED:\n${out}`, success: true };
      } catch (err: any) {
        const stdout = err.stdout || "";
        const stderr = err.stderr || "";
        return { result: `TESTS FAILED:\n${stdout}\n${stderr}`, success: false };
      }
    }

    if (name === "list_files") {
      const targetDir = args.dir || ".";
      if (!isPathInside(workDir, targetDir)) {
        return { result: "Error: Access outside repository denied", success: false };
      }
      const resolvedTarget = resolve(workDir, targetDir);
      const files = readdirSync(resolvedTarget, { recursive: true, encoding: "utf-8" })
        .map(f => String(f).replace(/\\/g, "/"));
      return { result: files.join("\n"), success: true };
    }

    return { result: `Unknown tool: ${name}`, success: false };
  } catch (err: any) {
    return { result: `Tool error: ${err.message}`, success: false };
  }
}

export async function callModelStream(
  modelId: string,
  messages: any[],
  maxTokens: number = 3000,
  timeoutMs: number = 60000
): Promise<{
  ok: boolean;
  status: number;
  content: string;
  ttfbMs: number;
  totalTimeMs: number;
  usage?: TokenUsage;
  error?: string;
}> {
  const start = Date.now();
  let firstByteMs = 0;
  let fullText = "";

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: true,
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) {
      const err = await res.text();
      return {
        ok: false,
        status: res.status,
        content: "",
        ttfbMs: Date.now() - start,
        totalTimeMs: Date.now() - start,
        error: err.slice(0, 300)
      };
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let usage: TokenUsage | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === 0) firstByteMs = Date.now() - start;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) fullText += delta;
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0
            };
          }
        } catch {}
      }
    }

    return {
      ok: true,
      status: 200,
      content: fullText,
      ttfbMs: firstByteMs || (Date.now() - start),
      totalTimeMs: Date.now() - start,
      usage
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      content: "",
      ttfbMs: firstByteMs || (Date.now() - start),
      totalTimeMs: Date.now() - start,
      error: err.message
    };
  }
}

export function evaluateStrongTask(taskId: string, content: string): {
  correct: boolean;
  score: number;
  criticalOmissions: string[];
  hallucinations: string[];
  constraintFailures: string[];
} {
  const norm = content.toLowerCase();
  const criticalOmissions: string[] = [];
  const hallucinations: string[] = [];
  const constraintFailures: string[] = [];

  let criteriaMet = 0;
  let maxPoints = 5;

  if (taskId === "ST-01") {
    // Saga vs Outbox / Dual-Write
    const hasOutboxOrCdc = /transactional outbox|outbox pattern|cdc|change data capture|debezium/i.test(norm);
    const hasSameTx = /same (local )?(database |db )?transaction|same tx|atomically in (the )?db|atomic with the order/i.test(norm);
    const hasIdempotency = /idempotenc|idempotent/i.test(norm);
    const hasDurableSaga = /saga (state|log|orchestrat|coordinator)|persistent (state|saga)/i.test(norm);
    const hasCompensationTimeout = /compensation.*(timeout|retry|dlq|manual|dead letter)|(timeout|fail).*compensat.*(retry|escalat|dlq)/i.test(norm);
    const used2PC = /\b2pc\b|two[- ]phase commit|\bxa\b/i.test(norm) && !/no 2pc|not 2pc|avoid 2pc|without 2pc|prohibit.*2pc|instead of 2pc/i.test(norm);
    const claimedAppRetryAtomic = /application[- ]level retry makes.*atomic|retry.*ensures atomicity/i.test(norm);

    if (hasOutboxOrCdc) criteriaMet++; else criticalOmissions.push("Omitted Transactional Outbox pattern or CDC");
    if (hasSameTx) criteriaMet++; else criticalOmissions.push("Omitted writing outbox in the same local DB transaction as the order");
    if (hasIdempotency) criteriaMet++; else criticalOmissions.push("Omitted publisher/consumer idempotency keys");
    if (hasDurableSaga) criteriaMet++; else criticalOmissions.push("Omitted persistent/durable saga state tracking");
    if (hasCompensationTimeout) criteriaMet++; else criticalOmissions.push("Omitted compensation timeout recovery (retry/DLQ/escalation)");
    if (used2PC) constraintFailures.push("Violated constraint by proposing 2PC/XA");
    if (claimedAppRetryAtomic) hallucinations.push("Falsely claimed application retries make dual-writes atomic");

  } else if (taskId === "ST-02") {
    // PostgreSQL oversell under READ COMMITTED
    const identifiesRace = /lost update|check[- ]then[- ]act|race condition|read committed.*does not prevent|concurrent.*read/i.test(norm);
    const givesAtomicUpdate = /update.*inventory.*set.*reserved.*where.*(available|stock)|reserved \+.*<=|stock - reserved >=/i.test(norm);
    const givesForUpdate = /select.*for update|row[- ]level lock/i.test(norm);
    const mentionsRetry = /40001|40p01|serialization|deadlock|lock timeout|retry/i.test(norm);
    const preservesNonNegative = /non[- ]negative|>= 0|cannot fall below zero|prevents oversell/i.test(norm);
    const claimsReadCommittedProtects = /read committed prevents oversell|read committed locks rows automatically on select/i.test(norm);

    if (identifiesRace) criteriaMet++; else criticalOmissions.push("Failed to identify lost update / check-then-act race under READ COMMITTED");
    if (givesAtomicUpdate) criteriaMet++; else criticalOmissions.push("Omitted atomic conditional UPDATE with available/stock predicate");
    if (givesForUpdate) criteriaMet++; else criticalOmissions.push("Omitted SELECT FOR UPDATE locking remediation");
    if (mentionsRetry) criteriaMet++; else criticalOmissions.push("Omitted bounded retry for 40001 / lock serialization failure");
    if (preservesNonNegative) criteriaMet++; else criticalOmissions.push("Omitted explicit guarantee of non-negative stock invariant");
    if (claimsReadCommittedProtects) hallucinations.push("Falsely claimed READ COMMITTED prevents overselling");

  } else if (taskId === "ST-03") {
    // Tenant pool starvation isolation
    const rejectsFifo = /reject|insufficient|unacceptable|unfair|starv.*all|fifo.*monopoliz/i.test(norm) && /shared fifo|single pool/i.test(norm);
    const perTenantQuota = /per[- ]tenant (quota|limit|pool|reservation|budget)|fair (queue|scheduling|share)|deficit round robin/i.test(norm);
    const tenantTimeout = /statement_timeout|query timeout|timeout per tenant|tenant[- ]level timeout/i.test(norm);
    const circuitBreaker = /circuit breaker|admission control|shed|rate limit/i.test(norm);
    const tenantObservability = /tenant.*(metric|observab|dashboard|log|telemetry)|metrics by tenant/i.test(norm);
    const naivePoolIncreaseOnly = /just (increase|raise) max_connections to/i.test(norm);

    if (rejectsFifo) criteriaMet++; else criticalOmissions.push("Failed to explicitly reject unpartitioned single shared FIFO pool");
    if (perTenantQuota) criteriaMet++; else criticalOmissions.push("Omitted per-tenant connection reservations, quotas, or fair queuing");
    if (tenantTimeout) criteriaMet++; else criticalOmissions.push("Omitted tenant-scoped statement_timeout");
    if (circuitBreaker) criteriaMet++; else criticalOmissions.push("Omitted circuit breaker or admission control for noisy tenant");
    if (tenantObservability) criteriaMet++; else criticalOmissions.push("Omitted per-tenant metric tracking / observability");
    if (naivePoolIncreaseOnly) hallucinations.push("Suggested merely increasing global connections as sole remedy");

  } else if (taskId === "ST-04") {
    // Webhook signature verification under proxying
    const rawBytesFirst = /raw (body|bytes|payload|buffer)|verify.*before.*json|do not parse before/i.test(norm);
    const timingSafe = /timingsafeequal|constant[- ]time|timing attack|timing safe/i.test(norm);
    const replayDefense = /timestamp|replay (attack|window)|tolerance|nonce|idempotenc/i.test(norm);
    const trustedProxy = /trusted proxy|trust proxy|x-forwarded-for.*untrusted|ip spoof/i.test(norm);
    const secretRotation = /secret rotation|(active|current) and (previous|old) secret|dual secret|rotate/i.test(norm);
    const parsedBeforeVerifying = /json\.parse.*then.*hmac|json\.stringify.*before (verif|hmac)/i.test(norm);

    if (rawBytesFirst) criteriaMet++; else criticalOmissions.push("Omitted requirement to verify raw payload bytes before JSON parsing");
    if (timingSafe) criteriaMet++; else criticalOmissions.push("Omitted constant-time comparison (crypto.timingSafeEqual) against timing attacks");
    if (replayDefense) criteriaMet++; else criticalOmissions.push("Omitted timestamp replay-window or nonce/idempotency verification");
    if (trustedProxy) criteriaMet++; else criticalOmissions.push("Omitted trusted-proxy validation for X-Forwarded headers");
    if (secretRotation) criteriaMet++; else criticalOmissions.push("Omitted grace-period handling for secret rotation (accept current and previous secret)");
    if (parsedBeforeVerifying) hallucinations.push("Falsely suggested JSON-stringifying parsed payload before HMAC verification");

  } else if (taskId === "ST-05") {
    // Zero-downtime 100M row migration
    const nullableFirst = /add column.*nullable|nullable first|without not null|not null.*later/i.test(norm);
    const dualWriting = /dual[- ]write|application.*write.*both|trigger.*new rows/i.test(norm);
    const batchedBackfill = /batch(ed|es)? backfill|throttl|bounded batch|chunk|sleep between/i.test(norm);
    const indexConcurrently = /create index concurrently|index.*concurrently/i.test(norm);
    const validateConstraint = /not valid.*validate constraint|validate constraint/i.test(norm);
    const singleAlterLockout = /alter table journal_entries add column.*not null default/i.test(norm);

    if (nullableFirst) criteriaMet++; else criticalOmissions.push("Omitted adding column as NULLABLE in initial phase");
    if (dualWriting) criteriaMet++; else criticalOmissions.push("Omitted application dual-writing or triggers for new writes");
    if (batchedBackfill) criteriaMet++; else criticalOmissions.push("Omitted throttled/bounded batch backfill for 100M historical rows");
    if (indexConcurrently) criteriaMet++; else criticalOmissions.push("Omitted CREATE INDEX CONCURRENTLY");
    if (validateConstraint) criteriaMet++; else criticalOmissions.push("Omitted NOT VALID constraint followed by VALIDATE CONSTRAINT");
    if (singleAlterLockout) hallucinations.push("Suggested single-statement ALTER TABLE ADD COLUMN NOT NULL on live 100M table");

  } else if (taskId === "ST-06") {
    // Retry storm and recovery design
    const exponentialBackoff = /exponential backoff.*jitter|jittered backoff/i.test(norm);
    const transientOnly = /transient (error|failure)|503|429|do not retry 4xx|fail fast on 40[0134]|non[- ]retryable/i.test(norm);
    const bulkheadConcurrency = /concurrency limit|bulkhead|rate limit/i.test(norm);
    const circuitBreaker = /circuit breaker/i.test(norm);
    const dlqOrEscalation = /dlq|dead[- ]letter|manual (review|recovery|intervention)/i.test(norm);
    const infiniteRetries = /retry indefinitely|infinite retries/i.test(norm);

    if (exponentialBackoff) criteriaMet++; else criticalOmissions.push("Omitted exponential backoff with full/decorrelated jitter");
    if (transientOnly) criteriaMet++; else criticalOmissions.push("Omitted error classification (only retry transient 503/429; fail fast on 4xx)");
    if (bulkheadConcurrency) criteriaMet++; else criticalOmissions.push("Omitted concurrency limits or bulkhead pattern");
    if (circuitBreaker) criteriaMet++; else criticalOmissions.push("Omitted circuit breaker protection");
    if (dlqOrEscalation) criteriaMet++; else criticalOmissions.push("Omitted Dead Letter Queue (DLQ) and manual recovery path");
    if (infiniteRetries) hallucinations.push("Recommended infinite unjittered retries during outage");

  } else if (taskId === "ST-07") {
    // Idempotent payments API contract
    const scopedKey = /scoped to (tenant|client|user|principal|account)|key scope/i.test(norm);
    const requestFingerprint = /fingerprint|payload hash|sha256|request hash|checksum/i.test(norm);
    const atomicRecord = /insert.*on conflict|unique constraint|atomic (insert|creation|claim)|select for update/i.test(norm);
    const stateTransitions = /pending|processing|completed|failed|state machine/i.test(norm);
    const conflictOnMismatch = /conflict|409|422|reject.*different (amount|payload|request)|mismatch/i.test(norm);
    const silentMismatchReuse = /return original payment without checking (amount|payload)/i.test(norm);

    if (scopedKey) criteriaMet++; else criticalOmissions.push("Omitted scoping idempotency key to principal/tenant/client");
    if (requestFingerprint) criteriaMet++; else criticalOmissions.push("Omitted request payload fingerprint / hash check");
    if (atomicRecord) criteriaMet++; else criticalOmissions.push("Omitted atomic idempotency key reservation (unique constraint / ON CONFLICT)");
    if (stateTransitions) criteriaMet++; else criticalOmissions.push("Omitted explicit idempotency lifecycle states (PENDING/PROCESSING/COMPLETED)");
    if (conflictOnMismatch) criteriaMet++; else criticalOmissions.push("Omitted 409/422 Conflict when same key is submitted with differing payload");
    if (silentMismatchReuse) hallucinations.push("Falsely allowed reusing transaction result without payload mismatch verification");

  } else if (taskId === "ST-08") {
    // Ambiguous evidence incident decision
    const statesUncertainty = /cannot (be )?conclude|insufficient evidence|inconclusive|not enough (data|evidence)|hypothesis|hypotheses/i.test(norm);
    const identifiesPoolSymptom = /timeout waiting for connection.*(symptom|not necessarily root cause)|connection pool.*hypothesis/i.test(norm);
    const safeMitigation = /revert (the )?feature flag|rollback (the )?deployment|shed load|rate limit|disable feature flag/i.test(norm);
    const gathersEvidence = /pg_stat_activity|active queries|pool (utilization|wait|metrics)|connection metrics|apm|traces|tenant breakdown/i.test(norm);
    const objectiveRollback = /rollback criteria|revert criteria|if p99 does not recover|sla violation threshold/i.test(norm);
    const assertsDefiniteCause = /the root cause is definitely|the database migration is the cause|the query text is the cause/i.test(norm);

    if (statesUncertainty) criteriaMet++; else criticalOmissions.push("Failed to state that evidence is insufficient to determine root cause");
    if (identifiesPoolSymptom) criteriaMet++; else criticalOmissions.push("Failed to identify connection timeout as a symptom/hypothesis rather than conclusion");
    if (safeMitigation) criteriaMet++; else criticalOmissions.push("Omitted safe, reversible first mitigation (e.g. toggle feature flag)");
    if (gathersEvidence) criteriaMet++; else criticalOmissions.push("Omitted essential diagnostic data collection (pg_stat_activity, pool depth, APM traces)");
    if (objectiveRollback) criteriaMet++; else criticalOmissions.push("Omitted objective rollback criteria based on p99 and error rates");
    if (assertsDefiniteCause) hallucinations.push("Prematurely asserted a definitive single root cause without telemetry proof");

  } else if (taskId === "ST-09") {
    // Latency regression diagnosis (2MB JSON compression)
    const compressionHypothesis = /compression (cpu|overhead|cost)|cpu[- ]bound compression|compression level|gzip|brotli/i.test(norm);
    const measurePlan = /cpu profile|flamegraph|benchmark.*compression|measure time spent in compression/i.test(norm);
    const payloadComparison = /compare (compressed vs uncompressed|with and without)|measure latency across (different )?payload size/i.test(norm);
    const selectiveTuning = /threshold|min size|max size|streaming compression|offload to (cdn|reverse proxy|nginx)|tune compression level/i.test(norm);
    const preservesCorrectness = /preserve correctness|maintain compression for|keep compression enabled for/i.test(norm);
    const blamedNetworkEgress = /network bottleneck|bandwidth limitation/i.test(norm) && !/network is not the bottleneck/i.test(norm);

    if (compressionHypothesis) criteriaMet++; else criticalOmissions.push("Omitted CPU compression overhead as primary latency hypothesis for 2MB payload");
    if (measurePlan) criteriaMet++; else criticalOmissions.push("Omitted CPU profiling / timing breakdown for compression step");
    if (payloadComparison) criteriaMet++; else criticalOmissions.push("Omitted comparative benchmark of compressed vs uncompressed 2MB payloads");
    if (selectiveTuning) criteriaMet++; else criticalOmissions.push("Omitted selective compression threshold, CDN offloading, or level tuning");
    if (preservesCorrectness) criteriaMet++; else criticalOmissions.push("Omitted maintaining compression where beneficial without global shutdown");
    if (blamedNetworkEgress) hallucinations.push("Blamed network egress bandwidth despite prompt stating egress was reduced");

  } else if (taskId === "ST-10") {
    // Authorization cache revocation trap
    const explainsRace = /pre[- ]commit.*race|reader.*cache.*stale|before commit.*stale data|rollback.*cache remains dirty/i.test(norm);
    const postCommitOrOutbox = /post[- ]commit (invalidation|del)|transactional outbox|cdc|listen\/notify|after commit/i.test(norm);
    const versioningOrFencing = /version|monotonic|fencing|timestamp|generation/i.test(norm);
    const sensitiveFailSafe = /sensitive (action|endpoint|operation)|bypass cache|verify against (db|database)|fail[- ]safe|require fresh/i.test(norm);
    const reconciliation = /reconcil|audit|ttl|background sync|observab/i.test(norm);
    const claimedPreCommitSafe = /pre[- ]commit (invalidation|del) is (sufficient|safe)|del before commit works/i.test(norm);

    if (explainsRace) criteriaMet++; else criticalOmissions.push("Failed to explain the pre-commit cache invalidation race condition");
    if (postCommitOrOutbox) criteriaMet++; else criticalOmissions.push("Omitted post-commit invalidation or Transactional Outbox / CDC");
    if (versioningOrFencing) criteriaMet++; else criticalOmissions.push("Omitted cache versioning, fencing tokens, or monotonic ordering");
    if (sensitiveFailSafe) criteriaMet++; else criticalOmissions.push("Omitted fail-safe / direct DB verification for high-risk sensitive operations");
    if (reconciliation) criteriaMet++; else criticalOmissions.push("Omitted cache reconciliation / TTL safeguard");
    if (claimedPreCommitSafe) hallucinations.push("Falsely claimed deleting Redis before PostgreSQL commit is safe");
  }

  const score = Math.min(1.0, criteriaMet / maxPoints);
  const correct = score >= 0.80 && criticalOmissions.length <= 1 && hallucinations.length === 0 && constraintFailures.length === 0;

  return {
    correct,
    score,
    criticalOmissions,
    hallucinations,
    constraintFailures
  };
}

export async function runStrongTask(
  task: any,
  model: { id: string; alias: string; name: string }
): Promise<StrongTaskResult> {
  const messages = [
    {
      role: "system",
      content: "You are an elite principal engineer and systems architect. Provide rigorous, precise, and unambiguous technical solutions. Explicitly state mechanisms, edge cases, invariants, failure recovery, and trade-offs. Adhere strictly to stated constraints."
    },
    {
      role: "user",
      content: task.prompt
    }
  ];

  let res = await callModelStream(model.id, messages, 3000, 75000);
  // Infra retry rule: max 1 retry for clear network/infra error
  if (!res.ok && (res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504)) {
    console.log(`    [Infra Retry] Retrying ${task.id} on ${model.alias} due to HTTP ${res.status}...`);
    res = await callModelStream(model.id, messages, 3000, 75000);
  }

  if (!res.ok) {
    return {
      taskId: task.id,
      category: "STRONG",
      taskName: task.name,
      modelId: model.id,
      modelAlias: model.alias,
      timestamp: new Date().toISOString(),
      operationalSuccess: false,
      qualitySuccess: false,
      correct: false,
      criticalOmissions: [`Operational failure: ${res.error || "Model call failed"}`],
      hallucinations: [],
      constraintFailures: [],
      score: 0,
      elapsedMs: res.totalTimeMs,
      ttfbMs: res.ttfbMs,
      rawResponse: res.error || ""
    };
  }

  const evaluation = evaluateStrongTask(task.id, res.content);

  return {
    taskId: task.id,
    category: "STRONG",
    taskName: task.name,
    modelId: model.id,
    modelAlias: model.alias,
    timestamp: new Date().toISOString(),
    operationalSuccess: true,
    qualitySuccess: evaluation.correct,
    correct: evaluation.correct,
    criticalOmissions: evaluation.criticalOmissions,
    hallucinations: evaluation.hallucinations,
    constraintFailures: evaluation.constraintFailures,
    score: evaluation.score,
    elapsedMs: res.totalTimeMs,
    ttfbMs: res.ttfbMs,
    usage: res.usage,
    rawResponse: res.content
  };
}

export async function runAgenticTask(
  task: any,
  model: { id: string; alias: string; name: string }
): Promise<AgenticTaskResult> {
  const start = Date.now();
  const workDir = resolve(`tmp/final-validation/agentic-${task.id}-${model.alias}`);
  const baseFixtureSrc = resolve("benchmark/cp7-2/fixtures/base");
  const caseFixtureSrc = resolve(`benchmark/cp7-2/fixtures/cases/${task.fixture}`);
  const hiddenTestSrc = resolve(`benchmark/cp7-2/fixtures/hidden/${task.hiddenTest}`);

  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  cpSync(baseFixtureSrc, workDir, { recursive: true });
  cpSync(caseFixtureSrc, workDir, { recursive: true });

  const changedFiles = new Set<string>();
  const prohibitedFiles = new Set<string>();
  const tools = createAgenticTools();

  const messages: any[] = [
    {
      role: "system",
      content: `You are an expert autonomous software engineer working in a Node/TypeScript repository.
You have tools to read, write, and patch files, and run tests.
Source files are under src/. Public tests are under test/.
CRITICAL: You are strictly restricted to modifying source files under src/. Tests and benchmark files are immutable.
Perform the task requested. Run tests with run_tests to verify your work.
When you have fixed/implemented the task and verified tests pass, conclude with a concise summary.`
    },
    {
      role: "user",
      content: task.prompt
    }
  ];

  let iterations = 0;
  let totalToolCalls = 0;
  let failedToolCalls = 0;
  let firstTtfb = 0;
  let prematureSuccess = false;
  let timeoutOrError: string | undefined;
  const maxIterations = 20;

  while (iterations < maxIterations) {
    if (Date.now() - start > 5 * 60 * 1000) {
      timeoutOrError = "Task exceeded 5 minute timeout";
      break;
    }
    iterations++;
    const callStart = Date.now();

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: model.id,
          messages,
          tools,
          tool_choice: "auto",
          stream: false,
          max_tokens: 2500
        }),
        signal: AbortSignal.timeout(65000)
      });
    } catch (err: any) {
      // 1 infra retry
      try {
        console.log(`    [Infra Retry] Retrying tool call turn on ${model.alias}...`);
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify({
            model: model.id,
            messages,
            tools,
            tool_choice: "auto",
            stream: false,
            max_tokens: 2500
          }),
          signal: AbortSignal.timeout(65000)
        });
      } catch (retryErr: any) {
        timeoutOrError = `Network/timeout error: ${retryErr.message}`;
        break;
      }
    }

    if (!res.ok) {
      const errText = await res.text();
      timeoutOrError = `HTTP error ${res.status}: ${errText.slice(0, 200)}`;
      break;
    }

    if (iterations === 1) firstTtfb = Date.now() - callStart;

    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const assistantMsg = choice?.message;
    if (!assistantMsg) break;

    messages.push(assistantMsg);
    const toolCalls = assistantMsg.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // Completed conversation turn
      break;
    }

    for (const tc of toolCalls) {
      totalToolCalls++;
      const fnName = tc.function.name;
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      const { result, success, prohibitedWrite } = executeAgenticTool(
        workDir,
        task.publicTest,
        fnName,
        args,
        changedFiles,
        prohibitedFiles
      );

      if (!success) failedToolCalls++;

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result
      });
    }
  }

  // Objective verification
  let publicTestsPassed = false;
  let publicTestOutput = "";
  try {
    publicTestOutput = execSync(`node --import tsx --test ${resolve(workDir, task.publicTest)}`, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 10000
    });
    publicTestsPassed = true;
  } catch (err: any) {
    publicTestOutput = (err.stdout || "") + "\n" + (err.stderr || "");
    publicTestsPassed = false;
  }

  let hiddenTestsPassed = false;
  let hiddenTestOutput = "";
  try {
    const hiddenDir = resolve(workDir, "test-hidden");
    if (!existsSync(hiddenDir)) mkdirSync(hiddenDir, { recursive: true });
    const localHidden = resolve(hiddenDir, "hidden.test.ts");
    cpSync(hiddenTestSrc, localHidden);
    hiddenTestOutput = execSync(`node --import tsx --test ${localHidden}`, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 10000
    });
    hiddenTestsPassed = true;
  } catch (err: any) {
    hiddenTestOutput = (err.stdout || "") + "\n" + (err.stderr || "");
    hiddenTestsPassed = false;
  }

  const passed = publicTestsPassed && hiddenTestsPassed;

  // Premature success check
  const lastMsg = messages[messages.length - 1]?.content || "";
  if (!passed && /tests? (pass|succeed|all green)|fixed successfully|ready for production|all requirements satisfied/i.test(lastMsg)) {
    prematureSuccess = true;
  }

  const score = passed ? 1.0 : (publicTestsPassed ? 0.5 : 0.0);

  return {
    taskId: task.id,
    category: "AGENTIC",
    taskName: task.name,
    modelId: model.id,
    modelAlias: model.alias,
    timestamp: new Date().toISOString(),
    operationalSuccess: !timeoutOrError,
    qualitySuccess: passed,
    finalTestsGreen: publicTestsPassed,
    hiddenTestsGreen: hiddenTestsPassed,
    iterations,
    toolCalls: totalToolCalls,
    failedToolCalls,
    timeoutOrError,
    prematureSuccess,
    elapsedMs: Date.now() - start,
    ttfbMs: firstTtfb,
    score,
    filesChanged: Array.from(changedFiles),
    publicOutputSnippet: publicTestOutput.slice(0, 300),
    hiddenOutputSnippet: hiddenTestOutput.slice(0, 300)
  };
}

async function main() {
  const args = process.argv.slice(2);
  const taskFilter = args.find((_, i) => args[i - 1] === "--task");
  const catFilter = args.find((_, i) => args[i - 1] === "--category");
  const modelFilter = args.find((_, i) => args[i - 1] === "--model");
  const resume = args.includes("--resume");
  const smoke = args.includes("--smoke");

  console.log("==================================================");
  console.log("FINAL PRODUCTION VALIDATION RUNNER (60 EVALUATIONS)");
  console.log("==================================================");

  const corpus = JSON.parse(readFileSync("benchmark/final-validation/corpus.json", "utf-8"));
  const rawDir = resolve("benchmark/final-validation/raw");
  if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });
  const resultsPath = resolve("benchmark/final-validation/results.json");

  const resultsMap = new Map<string, any>();
  if (existsSync(resultsPath) && resume) {
    const prev = JSON.parse(readFileSync(resultsPath, "utf-8"));
    for (const r of prev.records || []) {
      resultsMap.set(`${r.taskId}::${r.modelAlias}`, r);
    }
    console.log(`Loaded ${resultsMap.size} existing evaluations for resume.`);
  }

  // Model definitions
  const STRONG_MODELS = [
    { id: "cx/gpt-6-sol", alias: "gpt_6_sol", name: "GPT-6 Sol" },
    { id: "cx/gpt-6-luna", alias: "gpt_6_luna", name: "GPT-6 Luna" },
    { id: "ag/gemini-3.8-flash-high", alias: "gemini_high", name: "Gemini 3.8 Flash High" }
  ];

  const AGENTIC_MODELS = [
    { id: "cx/gpt-6-sol", alias: "gpt_6_sol", name: "GPT-6 Sol" },
    { id: "cx/gpt-6-luna", alias: "gpt_6_luna", name: "GPT-6 Luna" },
    { id: "ag/claude-sonnet-4-6", alias: "sonnet_4_6", name: "Claude Sonnet 4.6" }
  ];

  let strongTasks = corpus.strong.tasks as any[];
  let agenticTasks = corpus.agentic.tasks as any[];

  if (smoke) {
    strongTasks = strongTasks.slice(0, 1);
    agenticTasks = agenticTasks.slice(0, 1);
    console.log("SMOKE MODE ACTIVE: Running 1 Strong + 1 Agentic task across models");
  }

  if (taskFilter) {
    strongTasks = strongTasks.filter(t => t.id === taskFilter);
    agenticTasks = agenticTasks.filter(t => t.id === taskFilter);
  }

  // 1. RUN STRONG TASKS
  if (!catFilter || catFilter === "STRONG") {
    console.log(`\n--- RUNNING STRONG EVALUATION (${strongTasks.length} tasks x ${STRONG_MODELS.length} models) ---`);
    for (const task of strongTasks) {
      console.log(`\n[STRONG] ${task.id}: ${task.name}`);
      for (const model of STRONG_MODELS) {
        if (modelFilter && model.alias !== modelFilter && model.id !== modelFilter) continue;
        const key = `${task.id}::${model.alias}`;
        if (resume && resultsMap.has(key)) {
          console.log(`  * Skipping ${model.name} (already evaluated)`);
          continue;
        }

        console.log(`  > Evaluating on ${model.name}...`);
        const res = await runStrongTask(task, model);
        resultsMap.set(key, res);

        const rawFile = resolve(rawDir, `${task.id}_${model.alias}.json`);
        writeFileSync(rawFile, JSON.stringify(res, null, 2), "utf-8");

        console.log(`    Result: ${res.correct ? "PASS" : "FAIL"} (score: ${(res.score * 100).toFixed(0)}%) | Latency: ${res.elapsedMs}ms | TTFB: ${res.ttfbMs}ms`);
        if (res.criticalOmissions.length > 0) {
          console.log(`    Omissions: ${res.criticalOmissions.join("; ")}`);
        }
        if (res.hallucinations.length > 0) {
          console.log(`    Hallucinations: ${res.hallucinations.join("; ")}`);
        }
        if (res.constraintFailures.length > 0) {
          console.log(`    Constraint Failures: ${res.constraintFailures.join("; ")}`);
        }

        writeFileSync(resultsPath, JSON.stringify({
          version: EVALUATOR_VERSION,
          updatedAt: new Date().toISOString(),
          records: Array.from(resultsMap.values())
        }, null, 2), "utf-8");
      }
    }
  }

  // 2. RUN AGENTIC TASKS
  if (!catFilter || catFilter === "AGENTIC") {
    console.log(`\n--- RUNNING AGENTIC EVALUATION (${agenticTasks.length} tasks x ${AGENTIC_MODELS.length} models) ---`);
    for (const task of agenticTasks) {
      console.log(`\n[AGENTIC] ${task.id}: ${task.name}`);
      for (const model of AGENTIC_MODELS) {
        if (modelFilter && model.alias !== modelFilter && model.id !== modelFilter) continue;
        const key = `${task.id}::${model.alias}`;
        if (resume && resultsMap.has(key)) {
          console.log(`  * Skipping ${model.name} (already evaluated)`);
          continue;
        }

        console.log(`  > Evaluating on ${model.name}...`);
        const res = await runAgenticTask(task, model);
        resultsMap.set(key, res);

        const rawFile = resolve(rawDir, `${task.id}_${model.alias}.json`);
        writeFileSync(rawFile, JSON.stringify(res, null, 2), "utf-8");

        console.log(`    Result: ${res.qualitySuccess ? "ALL GREEN" : (res.finalTestsGreen ? "PUBLIC GREEN ONLY" : "FAIL")} | Tool Calls: ${res.toolCalls} | Iterations: ${res.iterations} | Latency: ${res.elapsedMs}ms`);
        if (res.timeoutOrError) {
          console.log(`    Error/Timeout: ${res.timeoutOrError}`);
        }
        if (res.prematureSuccess) {
          console.log(`    Premature Success Flagged!`);
        }

        writeFileSync(resultsPath, JSON.stringify({
          version: EVALUATOR_VERSION,
          updatedAt: new Date().toISOString(),
          records: Array.from(resultsMap.values())
        }, null, 2), "utf-8");
      }
    }
  }

  console.log("\n==================================================");
  console.log("FINAL VALIDATION RUNNER FINISHED");
  console.log("==================================================");
}

main().catch(err => {
  console.error("Fatal runner error:", err);
  process.exit(1);
});
