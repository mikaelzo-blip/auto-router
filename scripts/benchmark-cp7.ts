import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

export function isPathInside(baseDir: string, targetPath: string): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function isWritableSourcePath(workDir: string, targetPath: string): boolean {
  return isPathInside(resolve(workDir, "src"), resolve(workDir, targetPath));
}

const EVALUATOR_VERSION = "cp7-harness-2";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function classifyHttpFailure(status: number, error?: Error): string {
  if (status === 429) return "429_QUOTA";
  if (status >= 400 && status < 500) return "4XX_CLIENT_ERROR";
  if (status >= 500) return "5XX_PROVIDER";
  if (error) return "NETWORK_PROVIDER";
  return "HARNESS_FAILURE";
}

export function classifyAgenticOutcome(input: {
  sessionTimedOut: boolean;
  truncated: boolean;
  publicTestsPassed: boolean;
  hiddenTestsPassed: boolean;
}): { success: boolean; failureClass?: string } {
  if (input.sessionTimedOut) return { success: false, failureClass: "TIMEOUT" };
  if (input.truncated) return { success: false, failureClass: "TRUNCATION" };
  const success = input.publicTestsPassed && input.hiddenTestsPassed;
  return { success, failureClass: success ? undefined : "TEST_FAILURE" };
}

export function canonicalizeAttempts(
  entries: Array<{ file: string; result: CaseRunResult }>
): CaseRunResult[] {
  const latest = new Map<string, { result: CaseRunResult; attempt: number }>();
  for (const entry of entries) {
    const attemptMatch = entry.file.match(/_attempt-(\\d+)\\.json$/);
    const attempt = attemptMatch ? Number(attemptMatch[1]) : 0;
    const key = `${entry.result.caseId}:${entry.result.candidate}`;
    const current = latest.get(key);
    if (!current || attempt > current.attempt ||
        (attempt === current.attempt && entry.result.timestamp > current.result.timestamp)) {
      latest.set(key, { result: entry.result, attempt });
    }
  }
  return Array.from(latest.values())
    .sort((a, b) => a.result.timestamp.localeCompare(b.result.timestamp))
    .map(entry => entry.result);
}

const AGENTIC_SESSION_TIMEOUT_MS = 8 * 60 * 1000;

export function isAgenticSessionWithinDeadline(startedAtMs: number, nowMs = Date.now()): boolean {
  return nowMs - startedAtMs < AGENTIC_SESSION_TIMEOUT_MS;
}

export interface CaseRunResult {
  caseId: string;
  track: string;
  name: string;
  candidate: string;
  modelId: string;
  timestamp: string;
  ttfbMs: number;
  totalLatencyMs: number;
  httpStatus: number;
  success: boolean;
  failureClass?: string;
  tokens?: {
    prompt: number;
    completion: number;
    reasoning?: number;
  };
  outputSnippet?: string;
  fullOutput?: string;
  outputHash?: string;
  evaluatorVersion?: string;
  evaluation?: any;
  agenticDetails?: {
    iterations: number;
    toolCalls: number;
    failedToolCalls: number;
    filesChanged: string[];
    diff?: string;
    diffHash?: string;
    testsPassed: boolean;
    hiddenTestsPassed: boolean;
    publicTestOutput?: string;
    hiddenTestOutput?: string;
  };
}

// 1. Tool implementations for Agentic track
function createAgenticTools(workDir: string, testTarget: string) {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the repository",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to file, e.g. src/rate-limiter.ts" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write complete content to a file in the repository",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to file" },
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
        description: "Replace a unique string in a file with new content",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to file" },
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
        description: "Run the unit test suite for the current task",
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
  changedFiles: Set<string>
): { result: string; success: boolean } {
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
        return { result: "Error: Writes are restricted to source files; tests and package metadata are immutable", success: false };
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
        return { result: "Error: Patches are restricted to source files; tests and package metadata are immutable", success: false };
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

// 2. Evaluators for Qualitative Tracks
export function evaluateArchitecture(output: string, c: any) {
  const norm = output.toLowerCase();
  let score = 0;
  const details: Record<string, number> = {};

  const dimensions = c.rubric?.dimensions || [];
  for (const dim of dimensions) {
    let dimScore = 0;
    if (dim === "durability_guarantee") {
      if (norm.includes("durab") || norm.includes("fsync") || norm.includes("wal") || norm.includes("persist")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "queueing_and_backpressure") {
      if ((norm.includes("queue") || norm.includes("buffer")) && (norm.includes("backpressure") || norm.includes("rate limit"))) dimScore = 2;
      else if (norm.includes("queue")) dimScore = 1;
    } else if (dim === "idempotency_mechanism") {
      if (norm.includes("idempotenc") && (norm.includes("key") || norm.includes("hash") || norm.includes("uuid"))) dimScore = 2;
      else if (norm.includes("idempotenc")) dimScore = 1;
    } else if (dim === "duplicate_detection") {
      if (norm.includes("duplicate") || norm.includes("dedup")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "failure_recovery_and_dlq") {
      if ((norm.includes("dlq") || norm.includes("dead letter")) && (norm.includes("retry") || norm.includes("backoff"))) dimScore = 2;
      else if (norm.includes("retry")) dimScore = 1;
    } else if (dim === "operational_simplicity") {
      if (norm.includes("simple") || norm.includes("operat") || norm.includes("overhead") || norm.includes("trade-off")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "security_and_encryption") {
      if (norm.includes("encrypt") || norm.includes("auth") || norm.includes("tls") || norm.includes("tenant")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "observability_and_alerts") {
      if (norm.includes("metric") || norm.includes("alert") || norm.includes("observab") || norm.includes("monitor")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "tradeoff_analysis") {
      if (norm.includes("trade") || norm.includes("vs") || norm.includes("pros") || norm.includes("cons")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "decision_clarity") {
      if (output.length > 500 && (norm.includes("recommend") || norm.includes("architect") || norm.includes("conclusion"))) dimScore = 2;
      else dimScore = 0;
    } else {
      // General match
      const kw = dim.replace(/_/g, " ");
      if (norm.includes(kw) || norm.includes(dim.split("_")[0])) dimScore = 2;
      else dimScore = 0;
    }
    details[dim] = dimScore;
    score += dimScore;
  }

  const maxScore = dimensions.length * 2 || 20;
  return {
    score,
    maxScore,
    scoreRatio: Number((score / maxScore).toFixed(2)),
    dimensions: details,
    passed: score >= maxScore * 0.75
  };
}

export function evaluatePRD(output: string, c: any) {
  const norm = output.toLowerCase();
  let score = 0;
  const details: Record<string, number> = {};

  const dimensions = c.rubric?.dimensions || [];
  for (const dim of dimensions) {
    let dimScore = 0;
    if (dim === "problem_clarity_and_opportunity") {
      if (norm.includes("problem statement") || norm.includes("opportunity") || norm.includes("background")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "persona_and_jtbd_depth") {
      if ((norm.includes("persona") || norm.includes("user")) && (norm.includes("jtbd") || norm.includes("job"))) dimScore = 2;
      else if (norm.includes("persona") || norm.includes("user")) dimScore = 1;
    } else if (dim === "functional_requirements_moscow") {
      if (norm.includes("functional requirement") || norm.includes("must have") || norm.includes("moscow")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "nfr_completeness") {
      if (norm.includes("non-functional") || norm.includes("nfr") || norm.includes("latency") || norm.includes("uptime")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "workflow_state_machine") {
      if (norm.includes("workflow") || norm.includes("state") || norm.includes("step") || norm.includes("flow")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "edge_case_coverage" || dim === "edge_case_resilience") {
      if (norm.includes("edge case") || norm.includes("exception") || norm.includes("failure")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "acceptance_criteria_quality" || dim === "acceptance_criteria") {
      if (norm.includes("acceptance criteria") || norm.includes("given") || norm.includes("when")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "success_metrics_and_kpis") {
      if (norm.includes("metric") || norm.includes("kpi") || norm.includes("north star") || norm.includes("success")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "non_goals_discipline") {
      if (norm.includes("non-goal") || norm.includes("out of scope")) dimScore = 2;
      else dimScore = 0;
    } else if (dim === "implementation_handoff_readiness" || dim === "engineering_handoff_quality" || dim === "engineering_actionability" || dim === "engineering_handoff_clarity") {
      if (norm.includes("phase") || norm.includes("roadmap") || norm.includes("mvp") || norm.includes("rollout")) dimScore = 2;
      else dimScore = 0;
    } else {
      const kw = dim.replace(/_/g, " ");
      if (norm.includes(kw) || norm.includes(dim.split("_")[0])) dimScore = 2;
      else dimScore = 0;
    }
    details[dim] = dimScore;
    score += dimScore;
  }

  const maxScore = dimensions.length * 2 || 20;
  return {
    score,
    maxScore,
    scoreRatio: Number((score / maxScore).toFixed(2)),
    dimensions: details,
    passed: score >= maxScore * 0.75
  };
}

export function evaluateReasoning(output: string, c: any) {
  const norm = output.toLowerCase();
  const invariants = c.rubric?.invariants || [];
  const traps = c.rubric?.traps || [];

  let satisfiedInvariants = 0;
  const invariantResults: Array<{ text: string; satisfied: boolean }> = [];

  for (const inv of invariants) {
    const invLower = inv.toLowerCase();
    let satisfied = false;
    if (invLower.includes("check-then-act") || invLower.includes("race condition")) {
      satisfied = norm.includes("race") || norm.includes("check-then-act") || norm.includes("concurrency");
    } else if (invLower.includes("select ... for update") || invLower.includes("atomic conditional update")) {
      satisfied = (norm.includes("select") && norm.includes("for update")) || (norm.includes("update") && norm.includes("returning"));
    } else if (invLower.includes("deadlock") || invLower.includes("lock ordering")) {
      satisfied = norm.includes("deadlock") || norm.includes("order by") || norm.includes("lock order");
    } else if (invLower.includes("check constraint")) {
      satisfied = norm.includes("check") && (norm.includes("constraint") || norm.includes("balance >="));
    } else if (invLower.includes("idempotency record must be stored atomically")) {
      satisfied = norm.includes("atomic") || norm.includes("transaction") || norm.includes("outbox");
    } else if (invLower.includes("redis-only")) {
      satisfied = norm.includes("redis") && (norm.includes("evict") || norm.includes("partition") || norm.includes("restart") || norm.includes("loss"));
    } else if (invLower.includes("in-flight duplicates")) {
      satisfied = norm.includes("duplicate") || norm.includes("unique") || norm.includes("conflict") || norm.includes("409");
    } else if (invLower.includes("expand-and-contract")) {
      satisfied = norm.includes("expand") || norm.includes("contract") || norm.includes("phase") || norm.includes("dual");
    } else if (invLower.includes("single-statement")) {
      satisfied = norm.includes("bloat") || norm.includes("lock") || norm.includes("batch") || norm.includes("chunk");
    } else if (invLower.includes("rollback")) {
      satisfied = norm.includes("rollback") || norm.includes("revert");
    } else if (invLower.includes("accessexclusivelock")) {
      satisfied = norm.includes("exclusive") || norm.includes("lock");
    } else if (invLower.includes("vertical escalation")) {
      satisfied = norm.includes("vertical") || norm.includes("hierarchy") || (norm.includes("owner") && norm.includes("admin"));
    } else if (invLower.includes("cross-tenant")) {
      satisfied = norm.includes("tenant") || norm.includes("idor") || norm.includes("organization");
    } else if (invLower.includes("session invalidation") || invLower.includes("token")) {
      satisfied = norm.includes("token") || norm.includes("session") || norm.includes("revoc") || norm.includes("invalida");
    } else {
      satisfied = norm.includes(invLower.split(" ")[0]);
    }

    if (satisfied) satisfiedInvariants++;
    invariantResults.push({ text: inv, satisfied });
  }

  let avoidedTraps = 0;
  const trapResults: Array<{ text: string; avoided: boolean }> = [];
  for (const trap of traps) {
    const trapLower = trap.toLowerCase();
    let avoided = false;
    if (trapLower.includes("claiming application-level mutex")) {
      avoided = /(database|row).{0,80}(lock|transaction)|select.{0,30}for update/i.test(norm) &&
        !/(node|in-memory).{0,30}(mutex|lock).{0,30}(sufficient|guarantee)/i.test(norm);
    } else if (trapLower.includes("failing to sort ids")) {
      avoided = /(sort|sorted|deterministic).{0,40}(id|lock)|order by.{0,40}(id|user_id)/i.test(norm);
    } else if (trapLower.includes("proposing single massive update")) {
      avoided = /(batch|chunk|bounded|primary key).{0,60}(backfill|update)/i.test(norm) &&
        !/single.{0,30}(massive|transaction|statement).{0,30}update/i.test(norm);
    } else if (trapLower.includes("allowing admin to assign owner")) {
      avoided = /(cannot|can't|must not|prohibit|deny|forbid).{0,50}(assign|grant).{0,30}owner/i.test(norm) ||
        /(owner).{0,30}(higher|hierarchy|privilege).{0,30}(admin|caller)/i.test(norm);
    } else if (trapLower.includes("omitting the schema check constraint") || trapLower.includes("omitting the check constraint")) {
      avoided = norm.includes("check") && (norm.includes("constraint") || norm.includes("balance >="));
    } else if (trapLower.includes("storing idempotency key in redis without database")) {
      avoided = /(database|transaction|outbox).{0,80}atomic|atomic.{0,80}(database|transaction|outbox)/i.test(norm);
    } else if (trapLower.includes("returning http 500 on duplicate")) {
      avoided = /(return|respond|status).{0,30}(200|204|acknowledge|idempotent)/i.test(norm) &&
        !/(return|respond|status).{0,20}500/i.test(norm);
    } else if (trapLower.includes("ignoring cross-tenant target validation")) {
      avoided = /(same|exact|matching).{0,30}(tenant|organization|org_id)|tenant.{0,50}(check|validate|assert)/i.test(norm);
    } else if (trapLower.includes("fulfilling order before durable commit")) {
      avoided = /(do not|don't|must not|never|only after).{0,60}(fulfill|fulfil).{0,80}(durable|commit)|(?:durable|commit).{0,80}(before|prior to).{0,40}(fulfill|fulfil)/i.test(norm);
    } else if (trapLower.includes("adding not null column without default")) {
      avoided = /(nullable|without not null).{0,60}(first|before|then).{0,80}(not null|validate)|not null.{0,40}(after|later|validate|check)/i.test(norm) &&
        !/(add|adding).{0,30}not null.{0,30}(directly|immediately|without default)/i.test(norm);
    } else if (trapLower.includes("dropping old column before all application replicas")) {
      avoided = /(drop|remove).{0,80}(after|once|when).{0,80}(all|every).{0,30}(replica|instance).{0,50}(new|updated)|(?:all|every).{0,30}(replica|instance).{0,80}(before|prior to).{0,30}(drop|remove)/i.test(norm);
    } else if (trapLower.includes("only checking permission string")) {
      avoided = /(hierarch|role).{0,100}(target|ownership|same tenant|organization)|target.{0,80}(ownership|hierarch|tenant)/i.test(norm);
    }
    if (avoided) avoidedTraps++;
    trapResults.push({ text: trap, avoided });
  }

  const passed = satisfiedInvariants === invariants.length && avoidedTraps === traps.length;
  return {
    satisfiedInvariants,
    totalInvariants: invariants.length,
    avoidedTraps,
    totalTraps: traps.length,
    invariantResults,
    trapResults,
    passed
  };
}

// 3. Execution for Qualitative Tracks
async function runQualitativeCase(caseItem: any, candidateAlias: string, modelId: string): Promise<CaseRunResult> {
  const start = Date.now();
  let ttfbMs = 0;
  let content = "";
  let usage: any = null;
  let truncated = false;
  let httpStatus = 0;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: "You are a Principal Software Architect and Staff Engineer. Provide exhaustive, rigorous, production-grade responses adhering strictly to technical requirements and edge cases." },
          { role: "user", content: caseItem.prompt }
        ],
        stream: true,
        max_tokens: 3000
      }),
      signal: AbortSignal.timeout(180000)
    });

    httpStatus = res.status;
    if (!res.ok) {
      const err = await res.text();
      return {
        caseId: caseItem.caseId,
        track: caseItem.track,
        name: caseItem.name,
        candidate: candidateAlias,
        modelId,
        timestamp: new Date().toISOString(),
        ttfbMs: Date.now() - start,
        totalLatencyMs: Date.now() - start,
        httpStatus,
        success: false,
        failureClass: classifyHttpFailure(httpStatus),
        outputSnippet: err.slice(0, 300)
      };
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let firstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunk) {
        ttfbMs = Date.now() - start;
        firstChunk = false;
      }
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.usage) usage = parsed.usage;
          if (parsed.choices?.[0]?.finish_reason === "length") truncated = true;
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
        } catch {}
      }
    }

    const totalLatencyMs = Date.now() - start;

    let evaluation: any = null;
    if (caseItem.track === "architecture") {
      evaluation = evaluateArchitecture(content, caseItem);
    } else if (caseItem.track === "prd") {
      evaluation = evaluatePRD(content, caseItem);
    } else if (caseItem.track === "reasoning") {
      evaluation = evaluateReasoning(content, caseItem);
    }

    return {
      caseId: caseItem.caseId,
      track: caseItem.track,
      name: caseItem.name,
      candidate: candidateAlias,
      modelId,
      timestamp: new Date().toISOString(),
      ttfbMs,
      totalLatencyMs,
      httpStatus,
      tokens: {
        prompt: usage?.prompt_tokens || 0,
        completion: usage?.completion_tokens || 0,
        reasoning: usage?.completion_tokens_details?.reasoning_tokens
      },
      outputSnippet: content.slice(0, 300),
      fullOutput: content,
      outputHash: sha256(content),
      evaluatorVersion: EVALUATOR_VERSION,
      evaluation: {
        ...evaluation,
        provisional: true,
        decision: "MANUAL_REVIEW_REQUIRED"
      },
      success: false,
      failureClass: truncated ? "TRUNCATION" : "MANUAL_REVIEW_REQUIRED"
    };
  } catch (err: any) {
    return {
      caseId: caseItem.caseId,
      track: caseItem.track,
      name: caseItem.name,
      candidate: candidateAlias,
      modelId,
      timestamp: new Date().toISOString(),
      ttfbMs: ttfbMs || (Date.now() - start),
      totalLatencyMs: Date.now() - start,
      httpStatus,
      success: false,
      failureClass: err.name === "TimeoutError" ? "TIMEOUT" : classifyHttpFailure(0, err),
      outputSnippet: err.message
    };
  }
}

// 4. Execution for Agentic Coding Track
async function runAgenticCase(caseItem: any, candidateAlias: string, modelId: string): Promise<CaseRunResult> {
  const start = Date.now();
  const workDir = resolve(`tmp/cp7-agentic/${caseItem.caseId}-${candidateAlias}`);
  const fixtureSrc = resolve("benchmark/cp7/fixtures/repo");
  const hiddenTestSrc = resolve(`benchmark/cp7/fixtures/${caseItem.rubric.hiddenTestFile}`);

  // 1. Setup clean isolated worktree
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
  mkdirSync(workDir, { recursive: true });
  cpSync(fixtureSrc, workDir, { recursive: true });

  const changedFiles = new Set<string>();
  const tools = createAgenticTools(workDir, caseItem.rubric.testFile);

  const messages: any[] = [
    {
      role: "system",
      content: `You are an expert autonomous software engineer. You are working in a Node/TypeScript codebase.
You have tools to read, write, and patch files, and run tests.
Perform the task requested. Run tests with run_tests to verify your work.
When you have fixed/implemented the task and verified tests pass, conclude with a concise summary.`
    },
    {
      role: "user",
      content: caseItem.prompt
    }
  ];

  let iterations = 0;
  let totalToolCalls = 0;
  let failedToolCalls = 0;
  let firstTtfb = 0;
  let sessionTimedOut = false;
  let truncated = false;
  const maxIterations = 15;

  while (iterations < maxIterations) {
    if (!isAgenticSessionWithinDeadline(start)) {
      sessionTimedOut = true;
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
          model: modelId,
          messages,
          tools,
          tool_choice: "auto",
          stream: false,
          max_tokens: 2500
        }),
        signal: AbortSignal.timeout(60000)
      });
    } catch (err: any) {
      return {
        caseId: caseItem.caseId,
        track: caseItem.track,
        name: caseItem.name,
        candidate: candidateAlias,
        modelId,
        timestamp: new Date().toISOString(),
        ttfbMs: firstTtfb || (Date.now() - start),
        totalLatencyMs: Date.now() - start,
        httpStatus: 0,
        success: false,
        failureClass: err.name === "TimeoutError" ? "TIMEOUT" : classifyHttpFailure(0, err),
        agenticDetails: {
          iterations,
          toolCalls: totalToolCalls,
          failedToolCalls,
          filesChanged: Array.from(changedFiles),
          testsPassed: false,
          hiddenTestsPassed: false
        }
      };
    }

    if (!res.ok) {
      const err = await res.text();
      return {
        caseId: caseItem.caseId,
        track: caseItem.track,
        name: caseItem.name,
        candidate: candidateAlias,
        modelId,
        timestamp: new Date().toISOString(),
        ttfbMs: firstTtfb || (Date.now() - start),
        totalLatencyMs: Date.now() - start,
        httpStatus: res.status,
        success: false,
        failureClass: classifyHttpFailure(res.status),
        outputSnippet: err.slice(0, 300),
        agenticDetails: {
          iterations,
          toolCalls: totalToolCalls,
          failedToolCalls,
          filesChanged: Array.from(changedFiles),
          testsPassed: false,
          hiddenTestsPassed: false
        }
      };
    }

    if (iterations === 1) {
      firstTtfb = Date.now() - callStart;
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") truncated = true;
    const assistantMsg = choice?.message;
    if (!assistantMsg) break;

    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // Model finished without tool calls
      break;
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      totalToolCalls++;
      const fnName = tc.function.name;
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      const { result, success } = executeAgenticTool(workDir, caseItem.rubric.testFile, fnName, args, changedFiles);
      if (!success) failedToolCalls++;

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result
      });
    }
  }

  // Evaluate final state of the worktree
  let publicTestsPassed = false;
  let publicTestOutput = "";
  try {
    publicTestOutput = execSync(`node --import tsx --test ${resolve(workDir, caseItem.rubric.testFile)}`, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 10000
    });
    publicTestsPassed = true;
  } catch (err: any) {
    publicTestOutput = (err.stdout || "") + "\n" + (err.stderr || "");
    publicTestsPassed = false;
  }

  // Run hidden tests
  let hiddenTestsPassed = false;
  let hiddenTestOutput = "";
  try {
    const hiddenDir = resolve(workDir, "test-hidden");
    if (!existsSync(hiddenDir)) mkdirSync(hiddenDir, { recursive: true });
    const localHiddenTest = resolve(hiddenDir, "hidden.test.ts");
    cpSync(hiddenTestSrc, localHiddenTest);
    hiddenTestOutput = execSync(`node --import tsx --test ${localHiddenTest}`, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 10000
    });
    hiddenTestsPassed = true;
  } catch (err: any) {
    hiddenTestOutput = (err.stdout || "") + "\n" + (err.stderr || "");
    hiddenTestsPassed = false;
  }

  const outcome = classifyAgenticOutcome({
    sessionTimedOut,
    truncated,
    publicTestsPassed,
    hiddenTestsPassed
  });
  const success = outcome.success;
  let worktreeDiff = "";
  try {
    execSync(`git diff --no-index -- ${resolve(fixtureSrc, "src")} ${resolve(workDir, "src")}`, { encoding: "utf-8", stdio: "pipe" });
  } catch (err: any) {
    worktreeDiff = String(err.stdout || "");
  }

  return {
    caseId: caseItem.caseId,
    track: caseItem.track,
    name: caseItem.name,
    candidate: candidateAlias,
    modelId,
    timestamp: new Date().toISOString(),
    ttfbMs: firstTtfb,
    totalLatencyMs: Date.now() - start,
    httpStatus: 200,
    success,
    failureClass: outcome.failureClass,
    agenticDetails: {
      iterations,
      toolCalls: totalToolCalls,
      failedToolCalls,
      filesChanged: Array.from(changedFiles),
      diff: worktreeDiff,
      diffHash: sha256(worktreeDiff),
      testsPassed: publicTestsPassed,
      hiddenTestsPassed,
      publicTestOutput: publicTestOutput.slice(0, 500),
      hiddenTestOutput: hiddenTestOutput.slice(0, 500)
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isSmoke = args.includes("--smoke");
  const isFull = args.includes("--full");
  const trackArgIdx = args.indexOf("--track");
  const trackFilter = trackArgIdx !== -1 ? args[trackArgIdx + 1] : null;
  const caseArgIdx = args.indexOf("--case");
  const caseFilter = caseArgIdx !== -1 ? args[caseArgIdx + 1] : null;

  const corpusData = JSON.parse(readFileSync("benchmark/cp7/corpus.json", "utf-8"));
  let casesToRun = corpusData.cases;

  if (caseFilter) {
    casesToRun = casesToRun.filter((c: any) => c.caseId === caseFilter);
  } else if (isSmoke) {
    // 1 representative case from each track: A1, P1, R1, E1
    casesToRun = casesToRun.filter((c: any) => ["A1", "P1", "R1", "E1"].includes(c.caseId));
  } else if (trackFilter) {
    casesToRun = casesToRun.filter((c: any) => c.track === trackFilter);
  }

  console.log(`=== CP7 BENCHMARK RUNNER (${isSmoke ? "SMOKE (4 cases)" : isFull ? "FULL (16 cases)" : "CUSTOM"}) ===`);
  console.log(`Executing ${casesToRun.length} cases.`);

  const candidates = [
    { alias: "gemini_high", modelId: "ag/gemini-3.8-flash-high" },
    { alias: "sonnet_4_6", modelId: "ag/claude-sonnet-4-6" }
  ];

  mkdirSync("benchmark/cp7/raw", { recursive: true });
  const rawDir = "benchmark/cp7/raw";
  const manifestPath = "benchmark/cp7/manifest.json";
  let manifestEntries: Array<Record<string, any>> = [];
  if (existsSync(manifestPath)) {
    try {
      const parsedManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (Array.isArray(parsedManifest.entries)) manifestEntries = parsedManifest.entries;
    } catch {
      manifestEntries = [];
    }
  }

  const allResults: CaseRunResult[] = [];

  for (let i = 0; i < casesToRun.length; i++) {
    const c = casesToRun[i];
    console.log(`\n--------------------------------------------------`);
    console.log(`CASE ${c.caseId} [${c.track.toUpperCase()}]: ${c.name}`);
    console.log(`--------------------------------------------------`);

    // Rotate candidate order per case
    const orderedCandidates = i % 2 === 0
      ? [candidates[0], candidates[1]]
      : [candidates[1], candidates[0]];

    for (const cand of orderedCandidates) {
      const attemptPrefix = `${c.caseId}_${cand.alias}_attempt-`;
      const priorAttempts = readdirSync("benchmark/cp7/raw")
        .filter(file => file.startsWith(attemptPrefix) && file.endsWith(".json"));
      const attempt = priorAttempts.length + 1;
      const rawPath = `benchmark/cp7/raw/${attemptPrefix}${attempt}.json`;

      console.log(`> Running ${cand.alias} (${cand.modelId}), attempt ${attempt}...`);
      let result: CaseRunResult;

      if (c.track === "agentic") {
        result = await runAgenticCase(c, cand.alias, cand.modelId);
      } else {
        result = await runQualitativeCase(c, cand.alias, cand.modelId);
      }

      console.log(`  -> Status: ${result.httpStatus} | Success: ${result.success} | Latency: ${result.totalLatencyMs}ms | TTFB: ${result.ttfbMs}ms`);
      if (result.track === "agentic" && result.agenticDetails) {
        console.log(`  -> Agentic: iterations=${result.agenticDetails.iterations}, tools=${result.agenticDetails.toolCalls}, publicPass=${result.agenticDetails.testsPassed}, hiddenPass=${result.agenticDetails.hiddenTestsPassed}`);
      } else if (result.evaluation) {
        console.log(`  -> Score: ${JSON.stringify(result.evaluation)}`);
      }

      // Immediate atomic persistence
      writeFileSync(rawPath, JSON.stringify(result, null, 2), "utf-8");
      manifestEntries.push({
        caseId: result.caseId,
        candidate: result.candidate,
        attempt,
        file: rawPath,
        outputHash: result.outputHash,
        diffHash: result.agenticDetails?.diffHash,
        evaluatorVersion: result.evaluatorVersion,
        timestamp: result.timestamp
      });
      writeFileSync(manifestPath, JSON.stringify({
        evaluatorVersion: EVALUATOR_VERSION,
        entries: manifestEntries
      }, null, 2), "utf-8");
      allResults.push(result);
    }
  }

  // Summary generation
  console.log("\n=== SUMMARY OF RUN ===");
  const summary: Record<string, any> = {
    totalRuns: allResults.length,
    timestamp: new Date().toISOString(),
    isSmoke,
    byCandidate: {}
  };

  for (const cand of candidates) {
    const runs = allResults.filter(r => r.candidate === cand.alias);
    const passed = runs.filter(r => r.success);
    const avgLatency = runs.length ? Math.round(runs.reduce((acc, r) => acc + r.totalLatencyMs, 0) / runs.length) : 0;
    const avgTtfb = runs.length ? Math.round(runs.reduce((acc, r) => acc + r.ttfbMs, 0) / runs.length) : 0;

    summary.byCandidate[cand.alias] = {
      runs: runs.length,
      passed: passed.length,
      passRate: runs.length ? `${Math.round((passed.length / runs.length) * 100)}%` : "0%",
      avgLatencyMs: avgLatency,
      avgTtfbMs: avgTtfb
    };
  }

  console.log(JSON.stringify(summary, null, 2));

  // Compile only the canonical latest attempt for each case/candidate.
  const rawFiles = readdirSync(rawDir).filter(f => f.endsWith(".json"));
  const attemptEntries: Array<{ file: string; result: CaseRunResult }> = [];
  for (const rf of rawFiles) {
    try {
      const parsed = JSON.parse(readFileSync(join(rawDir, rf), "utf-8")) as CaseRunResult;
      attemptEntries.push({ file: rf, result: parsed });
    } catch {}
  }
  const allPersistedResults = canonicalizeAttempts(attemptEntries);
  writeFileSync(manifestPath, JSON.stringify({
    evaluatorVersion: EVALUATOR_VERSION,
    entries: allPersistedResults.map(result => ({
      caseId: result.caseId,
      candidate: result.candidate,
      outputHash: result.outputHash,
      diffHash: result.agenticDetails?.diffHash,
      evaluatorVersion: result.evaluatorVersion,
      timestamp: result.timestamp
    }))
  }, null, 2), "utf-8");

  const validManifestResults = manifestEntries.filter(entry =>
    allPersistedResults.some(result =>
      result.caseId === entry.caseId && result.candidate === entry.candidate &&
      result.timestamp === entry.timestamp
    )
  );
  if (validManifestResults.length !== allPersistedResults.length && allPersistedResults.length > 0) {
    throw new Error("Manifest does not cover every canonical benchmark result");
  }

  const globalSummary: Record<string, any> = {
    totalPersistedRuns: allPersistedResults.length,
    timestamp: new Date().toISOString(),
    byTrack: {},
    byCandidate: {}
  };

  for (const cand of candidates) {
    const runs = allPersistedResults.filter(r => r.candidate === cand.alias);
    const passed = runs.filter(r => r.success);
    const avgLatency = runs.length ? Math.round(runs.reduce((acc, r) => acc + r.totalLatencyMs, 0) / runs.length) : 0;
    const avgTtfb = runs.length ? Math.round(runs.reduce((acc, r) => acc + r.ttfbMs, 0) / runs.length) : 0;

    globalSummary.byCandidate[cand.alias] = {
      runs: runs.length,
      passed: passed.length,
      passRate: runs.length ? `${Math.round((passed.length / runs.length) * 100)}%` : "0%",
      avgLatencyMs: avgLatency,
      avgTtfbMs: avgTtfb
    };
  }

  const tracks = ["architecture", "prd", "reasoning", "agentic"];
  for (const t of tracks) {
    const trackRuns = allPersistedResults.filter(r => r.track === t);
    globalSummary.byTrack[t] = {
      total: trackRuns.length,
      geminiRuns: trackRuns.filter(r => r.candidate === "gemini_high").length,
      geminiPassed: trackRuns.filter(r => r.candidate === "gemini_high" && r.success).length,
      sonnetRuns: trackRuns.filter(r => r.candidate === "sonnet_4_6").length,
      sonnetPassed: trackRuns.filter(r => r.candidate === "sonnet_4_6" && r.success).length
    };
  }

  console.log("\nGLOBAL COMPILED SUMMARY:");
  console.log(JSON.stringify(globalSummary, null, 2));

  writeFileSync("benchmark/cp7/results.json", JSON.stringify(allPersistedResults, null, 2), "utf-8");
  writeFileSync("benchmark/cp7/summary.json", JSON.stringify(globalSummary, null, 2), "utf-8");
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch(err => {
    console.error("Benchmark runner fatal error:", err);
    process.exit(1);
  });
}
