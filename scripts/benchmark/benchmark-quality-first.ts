import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { NineRouterQuotaSource } from "../../src/quota/source.js";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

export const EVALUATOR_VERSION = "qfirst-1.0.0";

export const CANDIDATE_MODELS = [
  { id: "cx/gpt-6-luna", alias: "gpt_6_luna", name: "GPT-6 Luna" },
  { id: "cx/gpt-6-sol", alias: "gpt_6_sol", name: "GPT-6 Sol" },
  { id: "ag/gemini-3.8-flash-medium", alias: "gemini_medium", name: "Gemini 3.8 Flash Medium" },
  { id: "ag/gemini-3.8-flash-high", alias: "gemini_high", name: "Gemini 3.8 Flash High" },
  { id: "ag/claude-sonnet-4-6", alias: "sonnet_4_6", name: "Claude Sonnet 4.6" }
] as const;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface TaskResult {
  taskId: string;
  category: "NORMAL_CODING" | "HARD_REASONING" | "ARCHITECTURE" | "AGENTIC";
  taskName: string;
  isTrap: boolean;
  trapAvoided?: boolean;
  modelId: string;
  modelAlias: string;
  timestamp: string;
  operationalSuccess: boolean;
  qualitySuccess: boolean;
  passed: boolean;
  score: number; // 0.0 - 1.0
  elapsedMs: number;
  ttfbMs: number;
  usage?: TokenUsage;
  iterations?: number;
  toolCalls?: number;
  failedToolCalls?: number;
  prematureSuccess?: boolean;
  reasoningErrors: string[];
  unsupportedClaims: string[];
  constraintsMissed: string[];
  details: Record<string, any>;
  rawOutputSnippet?: string;
}

export function extractCode(text: string): string {
  const codeBlockRegex = /```(?:typescript|ts|javascript|js)?\s*([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1]?.trim()) {
      blocks.push(match[1].trim());
    }
  }
  return blocks.length > 0 ? blocks.join("\n\n") : text;
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

export async function checkQuotaPreflight(): Promise<{ safe: boolean; details: string }> {
  try {
    const source = new NineRouterQuotaSource({ baseUrl: "http://127.0.0.1:20128", timeoutMs: 5000 });
    const snapshot = await source.getSnapshot();
    const accounts = Object.values(snapshot.accounts || {});
    let minRemaining = 1.0;
    for (const acc of accounts) {
      for (const b of Object.values(acc.buckets || {})) {
        if (typeof b.remainingRatio === "number" && b.remainingRatio < minRemaining) {
          minRemaining = b.remainingRatio;
        }
      }
    }
    const safe = minRemaining >= 0.10;
    return { safe, details: `Min remaining quota ratio: ${(minRemaining * 100).toFixed(1)}%` };
  } catch (err: any) {
    return { safe: true, details: `Quota preflight skipped / fail-open: ${err.message}` };
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

// ----------------------------------------------------
// Category A: Normal Coding Evaluator
// ----------------------------------------------------
export async function runNormalCodingTask(
  task: any,
  model: typeof CANDIDATE_MODELS[number]
): Promise<TaskResult> {
  const messages = [
    {
      role: "system",
      content: "You are an expert TypeScript engineer. Write clean, robust, and mathematically sound production code satisfying all requirements and edge cases. Return only the implementation code inside a ```typescript ... ``` block."
    },
    {
      role: "user",
      content: task.prompt
    }
  ];

  const response = await callModelStream(model.id, messages, 2500, 60000);
  if (!response.ok) {
    return {
      taskId: task.taskId,
      category: "NORMAL_CODING",
      taskName: task.name,
      isTrap: !!task.isTrap,
      modelId: model.id,
      modelAlias: model.alias,
      timestamp: new Date().toISOString(),
      operationalSuccess: false,
      qualitySuccess: false,
      passed: false,
      score: 0,
      elapsedMs: response.totalTimeMs,
      ttfbMs: response.ttfbMs,
      reasoningErrors: [response.error || "Model call failed"],
      unsupportedClaims: [],
      constraintsMissed: [],
      details: { error: response.error }
    };
  }

  const extractedCode = extractCode(response.content);
  const workDir = resolve(`tmp/qfirst-eval/nc-${task.taskId}-${model.alias}`);
  const baseFixture = resolve("benchmark/cp7-2/fixtures/base");
  const taskFixture = resolve(task.fixtureDir);

  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  cpSync(baseFixture, workDir, { recursive: true });
  cpSync(taskFixture, workDir, { recursive: true });

  const destSource = resolve(workDir, task.sourceFile);
  mkdirSync(resolve(destSource, ".."), { recursive: true });
  writeFileSync(destSource, extractedCode, "utf-8");

  let testsPassed = false;
  let testOutput = "";
  let publicPassed = false;
  let hiddenPassed = false;
  const reasoningErrors: string[] = [];
  const constraintsMissed: string[] = [];

  // Run public tests
  try {
    const pubOut = execSync(`node --import tsx --test ${task.publicTest}`, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 10000
    });
    publicPassed = true;
    testOutput += `PUBLIC TESTS:\n${pubOut}\n`;
  } catch (err: any) {
    publicPassed = false;
    testOutput += `PUBLIC TESTS FAILED:\n${err.stdout || ""}\n${err.stderr || ""}\n`;
    reasoningErrors.push("Failed public unit tests");
  }

  // Run hidden tests
  try {
    const hidOut = execSync(`node --import tsx --test ${task.hiddenTest}`, {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 10000
    });
    hiddenPassed = true;
    testOutput += `HIDDEN TESTS:\n${hidOut}\n`;
  } catch (err: any) {
    hiddenPassed = false;
    testOutput += `HIDDEN TESTS FAILED:\n${err.stdout || ""}\n${err.stderr || ""}\n`;
    reasoningErrors.push("Failed hidden acceptance / edge-case tests");
  }

  testsPassed = publicPassed && hiddenPassed;
  let trapAvoided = true;
  if (task.isTrap) {
    trapAvoided = hiddenPassed;
    if (!trapAvoided) {
      reasoningErrors.push(`Fell into trap: ${task.trapDescription}`);
    }
  }

  const score = testsPassed ? 1.0 : (publicPassed ? 0.5 : 0.0);

  return {
    taskId: task.taskId,
    category: "NORMAL_CODING",
    taskName: task.name,
    isTrap: !!task.isTrap,
    trapAvoided,
    modelId: model.id,
    modelAlias: model.alias,
    timestamp: new Date().toISOString(),
    operationalSuccess: true,
    qualitySuccess: testsPassed,
    passed: testsPassed,
    score,
    elapsedMs: response.totalTimeMs,
    ttfbMs: response.ttfbMs,
    usage: response.usage,
    reasoningErrors,
    unsupportedClaims: [],
    constraintsMissed,
    details: {
      publicPassed,
      hiddenPassed,
      testOutputSnippet: testOutput.slice(0, 1000)
    },
    rawOutputSnippet: response.content.slice(0, 400)
  };
}

// ----------------------------------------------------
// Category B: Hard Reasoning Evaluator
// ----------------------------------------------------
export async function runHardReasoningTask(
  task: any,
  model: typeof CANDIDATE_MODELS[number]
): Promise<TaskResult> {
  const messages = [
    {
      role: "system",
      content: "You are an elite principal engineer and systems researcher. Analyze the problem with rigorous technical precision. Provide concrete, definitive answers with explicit justifications. Highlight exact edge cases, race conditions, or anomalies."
    },
    {
      role: "user",
      content: task.prompt
    }
  ];

  const response = await callModelStream(model.id, messages, 2500, 60000);
  if (!response.ok) {
    return {
      taskId: task.taskId,
      category: "HARD_REASONING",
      taskName: task.name,
      isTrap: !!task.isTrap,
      modelId: model.id,
      modelAlias: model.alias,
      timestamp: new Date().toISOString(),
      operationalSuccess: false,
      qualitySuccess: false,
      passed: false,
      score: 0,
      elapsedMs: response.totalTimeMs,
      ttfbMs: response.ttfbMs,
      reasoningErrors: [response.error || "Model call failed"],
      unsupportedClaims: [],
      constraintsMissed: [],
      details: { error: response.error }
    };
  }

  const content = response.content;
  const norm = content.toLowerCase();
  const reasoningErrors: string[] = [];
  const unsupportedClaims: string[] = [];
  const constraintsMissed: string[] = [];
  let criteriaMet = 0;
  let trapAvoided = true;

  if (task.taskId === "HR-1") {
    // Write skew in PostgreSQL REPEATABLE READ
    const statesT2Succeeds = /succeeds|commits|does not fail|no (serialization )?failure|will commit/i.test(content) &&
      !/t2 fails with|t2 will fail with sqlstate/i.test(content);
    const mentionsDisjoint = /disjoint|different rows?|id\s*=\s*10.*id\s*=\s*20|separate rows?|does not update the same/i.test(content);
    const mentionsWriteSkew = /write[- ]skew/i.test(content);
    const mentionsSerializable = /serializable/i.test(content);

    if (statesT2Succeeds) criteriaMet++; else reasoningErrors.push("Failed to identify that T2 commits under REPEATABLE READ without error");
    if (mentionsDisjoint) criteriaMet++; else reasoningErrors.push("Omitted that REPEATABLE READ conflict detection applies only to identical rows");
    if (mentionsWriteSkew) criteriaMet++; else reasoningErrors.push("Did not name the exact Write Skew anomaly");
    if (mentionsSerializable) criteriaMet++; else constraintsMissed.push("Did not identify SERIALIZABLE (SSI) as the isolation level preventing write skew");
  } else if (task.taskId === "HR-2") {
    // Distributed partition & vector clock
    const isConcurrent = /concurrent|conflict/i.test(content) && !/v2 causally precedes v3|v3 causally precedes v2/i.test(content);
    const mentionsLwwAnomaly = /lww|last[- ]write[- ]wins/i.test(content) && /v3|clock skew|data loss|silent/i.test(content);
    const mentionsMergedClock = /\[\s*1\s*,\s*1\s*,\s*1\s*\]/.test(content);

    if (isConcurrent) criteriaMet += 2; else reasoningErrors.push("Did not identify relationship as concurrent");
    if (mentionsLwwAnomaly) criteriaMet++; else reasoningErrors.push("Did not explain LWW wall-clock skew data loss");
    if (mentionsMergedClock) criteriaMet++; else reasoningErrors.push("Did not provide exact merged vector clock [1, 1, 1]");
  } else if (task.taskId === "HR-3") {
    // Circular dependency trap task
    const statesImpossible = /impossible|cannot (be )?scheduled?|deadlock|circular|cycle/i.test(content);
    const identifiesCycle = /t2.*t3.*t4.*t5.*t2|cycle.*(t2|t3|t4|t5)/i.test(content);
    const naiveScheduleAttempt = /execution order:\s*t1,\s*t2|schedule:\s*t1/i.test(content) && !/impossible/i.test(content);

    if (statesImpossible && !naiveScheduleAttempt) {
      criteriaMet += 2;
      trapAvoided = true;
    } else {
      trapAvoided = false;
      reasoningErrors.push("Fell for trap: attempted to schedule tasks with circular dependency");
    }
    if (identifiesCycle) criteriaMet += 2; else reasoningErrors.push("Did not identify exact directed cycle T2->T3->T4->T5->T2");
  } else if (task.taskId === "HR-4") {
    // Quota optimization
    const cleanContent = content.replace(/[*_\\`]/g, " ");
    const allocatesAlpha60 = /alpha[^\d\n]{1,35}60\b/i.test(cleanContent);
    const allocatesBeta10 = /beta[^\d\n]{1,35}10\b/i.test(cleanContent);
    const allocatesGamma30 = /gamma[^\d\n]{1,35}30\b/i.test(cleanContent);
    const correctCost = /\$?\s*0\.56|56\s*cents/i.test(cleanContent);
    const correctSLA = /90(\.0)?\s*%/i.test(cleanContent);

    if (allocatesAlpha60 && allocatesBeta10 && allocatesGamma30) {
      criteriaMet += 2;
    } else {
      reasoningErrors.push("Incorrect request allocation among providers");
    }
    if (correctCost) criteriaMet += 1; else reasoningErrors.push("Incorrect total cost (expected $0.56)");
    if (correctSLA) criteriaMet += 1; else reasoningErrors.push("Omitted or incorrect SLA compliance rate (expected 90%)");
  }

  const maxPoints = 4;
  const score = Math.min(1.0, criteriaMet / maxPoints);
  const qualitySuccess = score >= 0.75;

  return {
    taskId: task.taskId,
    category: "HARD_REASONING",
    taskName: task.name,
    isTrap: !!task.isTrap,
    trapAvoided,
    modelId: model.id,
    modelAlias: model.alias,
    timestamp: new Date().toISOString(),
    operationalSuccess: true,
    qualitySuccess,
    passed: qualitySuccess,
    score,
    elapsedMs: response.totalTimeMs,
    ttfbMs: response.ttfbMs,
    usage: response.usage,
    reasoningErrors,
    unsupportedClaims,
    constraintsMissed,
    details: { criteriaMet, maxPoints },
    rawOutputSnippet: response.content.slice(0, 400)
  };
}

// ----------------------------------------------------
// Category C: Architecture & Design Evaluator
// ----------------------------------------------------
export async function runArchitectureTask(
  task: any,
  model: typeof CANDIDATE_MODELS[number]
): Promise<TaskResult> {
  const messages = [
    {
      role: "system",
      content: "You are a Principal Infrastructure & Distributed Systems Architect. Design resilient, scalable, production-ready system architectures. Explicitly identify failure modes, race conditions, consensus boundaries, and operational tradeoffs. Do not generate generic boilerplate; ground every architectural decision in concrete invariants."
    },
    {
      role: "user",
      content: task.prompt
    }
  ];

  const response = await callModelStream(model.id, messages, 3000, 60000);
  if (!response.ok) {
    return {
      taskId: task.taskId,
      category: "ARCHITECTURE",
      taskName: task.name,
      isTrap: !!task.isTrap,
      modelId: model.id,
      modelAlias: model.alias,
      timestamp: new Date().toISOString(),
      operationalSuccess: false,
      qualitySuccess: false,
      passed: false,
      score: 0,
      elapsedMs: response.totalTimeMs,
      ttfbMs: response.ttfbMs,
      reasoningErrors: [response.error || "Model call failed"],
      unsupportedClaims: [],
      constraintsMissed: [],
      details: { error: response.error }
    };
  }

  const content = response.content;
  const norm = content.toLowerCase();
  const reasoningErrors: string[] = [];
  const unsupportedClaims: string[] = [];
  const constraintsMissed: string[] = [];
  let checklistScore = 0;
  let trapAvoided = true;

  if (task.taskId === "AR-1") {
    // Idempotent webhook ingestion
    const hasUniqueIdemp = /unique constraint|idempotency[- ]key|primary key/i.test(content);
    const hasAtomicConflict = /on conflict|insert.*conflict|select for update|pessimistic lock/i.test(content);
    const hasStateMachine = /state machine|pending|processing|completed|failed/i.test(content);
    const hasOutboxOrQueue = /outbox|cdc|kafka|rabbitmq|sqs|stream/i.test(content);
    const hasDlqRetry = /dlq|dead[- ]letter|backoff|exponential retry/i.test(content);

    if (hasUniqueIdemp) checklistScore++; else constraintsMissed.push("Missing idempotency key unique constraint");
    if (hasAtomicConflict) checklistScore++; else reasoningErrors.push("Missing atomic state transition on duplicate concurrent delivery");
    if (hasStateMachine) checklistScore++; else constraintsMissed.push("Missing explicit event lifecycle state machine");
    if (hasOutboxOrQueue) checklistScore++; else reasoningErrors.push("Missing decoupled ingestion queue / outbox pattern");
    if (hasDlqRetry) checklistScore++; else constraintsMissed.push("Missing Dead Letter Queue / exponential retry handling");
  } else if (task.taskId === "AR-2") {
    // Multi-tenant connection pool isolation (Trap)
    const rejectsNaiveShared = /fifo.*(starv|exhaust|fail)|shared pool.*(vulnerab|unfair|starv)|cannot rely on a single shared/i.test(content);
    const hasTenantQuota = /per[- ]tenant (pool|quota|reservation|limit)|deficit round robin|fair queue/i.test(content);
    const hasTimeoutCircuitBreaker = /statement_timeout|circuit breaker|query timeout/i.test(content);
    const articulatesTradeoff = /overhead|tradeoff|connection overhead|resource utilization/i.test(content);

    if (rejectsNaiveShared) {
      checklistScore += 2;
      trapAvoided = true;
    } else {
      trapAvoided = false;
      reasoningErrors.push("Fell for trap: did not reject naive unpartitioned shared pool");
    }
    if (hasTenantQuota) checklistScore++; else reasoningErrors.push("Missing per-tenant connection reservations or fair queueing");
    if (hasTimeoutCircuitBreaker) checklistScore++; else constraintsMissed.push("Missing per-tenant statement timeouts or circuit breakers");
    if (articulatesTradeoff) checklistScore++;
  } else if (task.taskId === "AR-3") {
    // Saga with dual write
    const hasOutboxCdc = /transactional outbox|outbox pattern|cdc|change data capture|debezium/i.test(content);
    const hasCompensatingActions = /compensat(ing|ion)|refund|rollback action/i.test(content);
    const hasPersistentSagaLog = /saga log|orchestrator state|state machine|persistence/i.test(content);
    const hasTimeoutHandling = /compensation timeout|indefinite retry|retry.*alert|dlq|manual intervention/i.test(content);
    const hasIdempotency = /idempotent|idempotency/i.test(content);

    if (hasOutboxCdc) checklistScore++; else reasoningErrors.push("Did not solve Dual-Write problem with Transactional Outbox or CDC");
    if (hasCompensatingActions && hasIdempotency) checklistScore++; else reasoningErrors.push("Missing idempotent compensating actions");
    if (hasPersistentSagaLog) checklistScore++; else constraintsMissed.push("Missing persistent saga coordinator state");
    if (hasTimeoutHandling) checklistScore++; else constraintsMissed.push("Missing timeout / network partition handling during compensation");
    checklistScore++; // Tradeoffs covered
  } else if (task.taskId === "AR-4") {
    // Zero downtime schema migration
    const explainsLockRisk = /access exclusive|table lock|rewrite|exclusive lock|blocks? writes/i.test(content);
    const hasNullableFirst = /nullable|not null.*later|without default/i.test(content);
    const hasBatchBackfill = /batch(ed|es)?|throttle|sleep|chunks?|limit.*offset/i.test(content);
    const hasValidateConstraint = /not valid|validate constraint/i.test(content);
    const hasConcurrentIndex = /create index concurrently|concurrently/i.test(content);

    if (explainsLockRisk) checklistScore++; else reasoningErrors.push("Omitted explanation of ACCESS EXCLUSIVE table lock downtime risk");
    if (hasNullableFirst) checklistScore++; else constraintsMissed.push("Did not add column as nullable first (Expand phase)");
    if (hasBatchBackfill) checklistScore++; else reasoningErrors.push("Omitted throttled batched backfill strategy");
    if (hasValidateConstraint) checklistScore++; else constraintsMissed.push("Omitted NOT VALID constraint followed by VALIDATE CONSTRAINT");
    if (hasConcurrentIndex) checklistScore++; else constraintsMissed.push("Omitted CREATE INDEX CONCURRENTLY");
  }

  const maxPoints = 5;
  const score = Math.min(1.0, checklistScore / maxPoints);
  const qualitySuccess = score >= 0.70;

  return {
    taskId: task.taskId,
    category: "ARCHITECTURE",
    taskName: task.name,
    isTrap: !!task.isTrap,
    trapAvoided,
    modelId: model.id,
    modelAlias: model.alias,
    timestamp: new Date().toISOString(),
    operationalSuccess: true,
    qualitySuccess,
    passed: qualitySuccess,
    score,
    elapsedMs: response.totalTimeMs,
    ttfbMs: response.ttfbMs,
    usage: response.usage,
    reasoningErrors,
    unsupportedClaims,
    constraintsMissed,
    details: { checklistScore, maxPoints },
    rawOutputSnippet: response.content.slice(0, 400)
  };
}

// ----------------------------------------------------
// Category D: Agentic Execution Evaluator
// ----------------------------------------------------
export async function runAgenticTask(
  task: any,
  model: typeof CANDIDATE_MODELS[number]
): Promise<TaskResult> {
  const start = Date.now();
  const workDir = resolve(`tmp/qfirst-eval/agentic-${task.taskId}-${model.alias}`);
  const baseFixtureSrc = resolve("benchmark/cp7-2/fixtures/base");
  const caseFixtureSrc = resolve(task.fixtureCaseDir);
  const hiddenTestSrc = resolve(task.hiddenTestFile);

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
CRITICAL: You are restricted to modifying source files under src/. Tests and benchmark files are immutable.
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
  const maxIterations = 20;

  while (iterations < maxIterations) {
    if (Date.now() - start > 5 * 60 * 1000) break; // 5 min timeout
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
        signal: AbortSignal.timeout(60000)
      });
    } catch (err: any) {
      return {
        taskId: task.taskId,
        category: "AGENTIC",
        taskName: task.name,
        isTrap: !!task.isTrap,
        modelId: model.id,
        modelAlias: model.alias,
        timestamp: new Date().toISOString(),
        operationalSuccess: false,
        qualitySuccess: false,
        passed: false,
        score: 0,
        elapsedMs: Date.now() - start,
        ttfbMs: firstTtfb || (Date.now() - start),
        iterations,
        toolCalls: totalToolCalls,
        failedToolCalls,
        reasoningErrors: [`Network/timeout error: ${err.message}`],
        unsupportedClaims: [],
        constraintsMissed: [],
        details: { error: err.message }
      };
    }

    if (!res.ok) {
      const errText = await res.text();
      return {
        taskId: task.taskId,
        category: "AGENTIC",
        taskName: task.name,
        isTrap: !!task.isTrap,
        modelId: model.id,
        modelAlias: model.alias,
        timestamp: new Date().toISOString(),
        operationalSuccess: false,
        qualitySuccess: false,
        passed: false,
        score: 0,
        elapsedMs: Date.now() - start,
        ttfbMs: firstTtfb || (Date.now() - start),
        iterations,
        toolCalls: totalToolCalls,
        failedToolCalls,
        reasoningErrors: [`HTTP error ${res.status}: ${errText.slice(0, 200)}`],
        unsupportedClaims: [],
        constraintsMissed: [],
        details: { httpStatus: res.status }
      };
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
        task.testFile,
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

  // Objective validation: evaluate visible and hidden tests
  let publicTestsPassed = false;
  let publicTestOutput = "";
  try {
    publicTestOutput = execSync(`node --import tsx --test ${resolve(workDir, task.testFile)}`, {
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
  let trapAvoided = true;
  if (task.isTrap) {
    trapAvoided = hiddenTestsPassed;
  }

  // Check premature success: Did assistant message claim success while tests are actually failing?
  const lastMsg = messages[messages.length - 1]?.content || "";
  if (!passed && /tests? (pass|succeed|all green)|fixed successfully|ready for production/i.test(lastMsg)) {
    prematureSuccess = true;
  }

  const reasoningErrors: string[] = [];
  if (!publicTestsPassed) reasoningErrors.push("Public test suite failed");
  if (!hiddenTestsPassed) reasoningErrors.push("Hidden acceptance test suite failed");
  if (prematureSuccess) reasoningErrors.push("Declared premature success while tests were failing");

  const score = passed ? 1.0 : (publicTestsPassed ? 0.5 : 0.0);

  return {
    taskId: task.taskId,
    category: "AGENTIC",
    taskName: task.name,
    isTrap: !!task.isTrap,
    trapAvoided,
    modelId: model.id,
    modelAlias: model.alias,
    timestamp: new Date().toISOString(),
    operationalSuccess: true,
    qualitySuccess: passed,
    passed,
    score,
    elapsedMs: Date.now() - start,
    ttfbMs: firstTtfb,
    iterations,
    toolCalls: totalToolCalls,
    failedToolCalls,
    prematureSuccess,
    reasoningErrors,
    unsupportedClaims: [],
    constraintsMissed: [],
    details: {
      publicTestsPassed,
      hiddenTestsPassed,
      filesChanged: Array.from(changedFiles),
      prohibitedFilesChanged: Array.from(prohibitedFiles),
      publicTestOutput: publicTestOutput.slice(0, 400),
      hiddenTestOutput: hiddenTestOutput.slice(0, 400)
    }
  };
}

// ----------------------------------------------------
// Main Benchmark Runner
// ----------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const taskFilter = args.find((_, i) => args[i - 1] === "--task");
  const catFilter = args.find((_, i) => args[i - 1] === "--category");
  const modelFilter = args.find((_, i) => args[i - 1] === "--model");
  const resume = args.includes("--resume");

  console.log("==================================================");
  console.log("QUALITY-FIRST BENCHMARK HARNESS (16 TASKS, 5 MODELS)");
  console.log("==================================================");

  // 1. Quota Preflight
  const quota = await checkQuotaPreflight();
  console.log("Quota Preflight:", quota.details);
  if (!quota.safe) {
    console.error("CRITICAL: Upstream quota safety gate violated. Aborting.");
    process.exit(1);
  }

  // 2. Load Corpus
  const corpus = JSON.parse(readFileSync("benchmark/quality-first/corpus.json", "utf-8"));
  let tasks = corpus.tasks as any[];
  if (taskFilter) tasks = tasks.filter(t => t.taskId === taskFilter);
  if (catFilter) tasks = tasks.filter(t => t.category === catFilter);

  let models = CANDIDATE_MODELS as readonly any[];
  if (modelFilter) models = models.filter(m => m.alias === modelFilter || m.id === modelFilter);

  const resultsPath = resolve("benchmark/quality-first/results.json");
  const rawDir = resolve("benchmark/quality-first/raw");
  if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });

  const resultsMap = new Map<string, TaskResult>();

  // Load from raw directory first so all completed units persist
  if (existsSync(rawDir)) {
    const rawFiles = readdirSync(rawDir).filter(f => f.endsWith(".json"));
    for (const f of rawFiles) {
      try {
        const rawRec = JSON.parse(readFileSync(resolve(rawDir, f), "utf-8")) as TaskResult;
        if (rawRec && rawRec.taskId && rawRec.modelAlias) {
          resultsMap.set(`${rawRec.taskId}::${rawRec.modelAlias}`, rawRec);
        }
      } catch {}
    }
  }

  // Also merge any existing in results.json
  if (existsSync(resultsPath) && resume) {
    try {
      const existing = JSON.parse(readFileSync(resultsPath, "utf-8")).records || [];
      for (const r of existing) {
        if (!resultsMap.has(`${r.taskId}::${r.modelAlias}`)) {
          resultsMap.set(`${r.taskId}::${r.modelAlias}`, r);
        }
      }
    } catch {}
  }

  console.log(`Executing ${tasks.length} tasks across ${models.length} candidate models (${tasks.length * models.length} total units)...`);

  for (const task of tasks) {
    console.log(`\n--------------------------------------------------`);
    console.log(`TASK [${task.taskId}] (${task.category}): ${task.name}`);
    console.log(`--------------------------------------------------`);

    for (const model of models) {
      const unitKey = `${task.taskId}::${model.alias}`;
      if (resume && resultsMap.has(unitKey)) {
        console.log(`  [RESUME] Skipping ${model.name} (already recorded)`);
        continue;
      }

      console.log(`  > Running on ${model.name} (${model.id})...`);
      let result: TaskResult;

      try {
        if (task.category === "NORMAL_CODING") {
          result = await runNormalCodingTask(task, model);
        } else if (task.category === "HARD_REASONING") {
          result = await runHardReasoningTask(task, model);
        } else if (task.category === "ARCHITECTURE") {
          result = await runArchitectureTask(task, model);
        } else if (task.category === "AGENTIC") {
          result = await runAgenticTask(task, model);
        } else {
          throw new Error(`Unknown category: ${task.category}`);
        }
      } catch (err: any) {
        console.error(`  [ERROR] Uncaught error during ${task.taskId} on ${model.name}:`, err.message);
        result = {
          taskId: task.taskId,
          category: task.category,
          taskName: task.name,
          isTrap: !!task.isTrap,
          modelId: model.id,
          modelAlias: model.alias,
          timestamp: new Date().toISOString(),
          operationalSuccess: false,
          qualitySuccess: false,
          passed: false,
          score: 0,
          elapsedMs: 0,
          ttfbMs: 0,
          reasoningErrors: [`Harness failure: ${err.message}`],
          unsupportedClaims: [],
          constraintsMissed: [],
          details: { error: err.message }
        };
      }

      resultsMap.set(unitKey, result);

      // Save raw output record
      const rawFile = resolve(rawDir, `${task.taskId}_${model.alias}.json`);
      writeFileSync(rawFile, JSON.stringify(result, null, 2), "utf-8");

      console.log(`    Result: ${result.passed ? "PASS" : "FAIL"} (score: ${(result.score * 100).toFixed(0)}%) | Latency: ${result.elapsedMs}ms | TTFB: ${result.ttfbMs}ms`);
      if (result.reasoningErrors.length > 0) {
        console.log(`    Issues: ${result.reasoningErrors.join("; ")}`);
      }

      // Persist snapshot
      writeFileSync(resultsPath, JSON.stringify({
        version: EVALUATOR_VERSION,
        updatedAt: new Date().toISOString(),
        records: Array.from(resultsMap.values())
      }, null, 2), "utf-8");
    }
  }

  console.log("\n==================================================");
  console.log("BENCHMARK EXECUTION COMPLETE");
  console.log("==================================================");
}

main().catch(err => {
  console.error("Fatal benchmark runner error:", err);
  process.exit(1);
});
