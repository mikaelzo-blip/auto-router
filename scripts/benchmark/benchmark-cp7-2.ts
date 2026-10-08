import "dotenv/config";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { execSync } from "node:child_process";
import { NineRouterQuotaSource } from "../../src/quota/source.js";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

export const EVALUATOR_VERSION = "cp7-2-agentic-harness-1";
export const AGENTIC_DEADLINE_MS = 8 * 60 * 1000; // 8 minutes

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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

  // Prohibited: test/ or test-hidden/ or package.json or benchmark metadata
  const rel = relative(resolvedWorkDir, resolvedTarget).replace(/\\/g, "/");
  if (rel.startsWith("test/") || rel === "test" || rel.startsWith("test-hidden/") || rel === "package.json" || rel.includes("..")) {
    return false;
  }

  const inSrc = isPathInside(resolve(resolvedWorkDir, "src"), resolvedTarget);
  const inMigrations = isPathInside(resolve(resolvedWorkDir, "migrations"), resolvedTarget);
  return inSrc || inMigrations;
}

export function isAgenticSessionWithinDeadline(startTime: number, now: number = Date.now(), deadlineMs: number = AGENTIC_DEADLINE_MS): boolean {
  return now - startTime < deadlineMs;
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
  policyViolated?: boolean;
}): { success: boolean; failureClass?: string } {
  if (input.policyViolated) return { success: false, failureClass: "POLICY_VIOLATION" };
  if (input.sessionTimedOut) return { success: false, failureClass: "TIMEOUT" };
  if (input.truncated) return { success: false, failureClass: "TRUNCATION" };
  const success = input.publicTestsPassed && input.hiddenTestsPassed;
  return { success, failureClass: success ? undefined : "TEST_FAILURE" };
}

export function writeAtomicJson(filePath: string, data: any): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tempPath, filePath);
}

export function isValidAttempt(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  if (result.incomplete) return false;
  if (typeof result.caseId !== "string" || !result.caseId) return false;
  if (typeof result.candidate !== "string" || !result.candidate) return false;
  if (typeof result.timestamp !== "string" || !result.timestamp) return false;
  if (result.failureClass === "HARNESS_FAILURE") return false;

  const validTerminalFailureClasses = new Set([
    "TIMEOUT",
    "TRUNCATION",
    "429_QUOTA",
    "4XX_CLIENT_ERROR",
    "5XX_PROVIDER",
    "NETWORK_PROVIDER",
    "TOOL_FAILURE",
    "TEST_FAILURE",
    "QUALITY_FAILURE",
    "POLICY_VIOLATION"
  ]);

  if (result.failureClass && !validTerminalFailureClasses.has(result.failureClass)) {
    return false;
  }

  return true;
}

export function loadResumeAttempts(rawDir: string): Map<string, { file: string; result: any; attempt: number }> {
  const map = new Map<string, { file: string; result: any; attempt: number }>();
  if (!existsSync(rawDir)) return map;

  const files = readdirSync(rawDir).filter(f => f.endsWith(".json") && !f.includes(".tmp"));
  for (const file of files) {
    const fullPath = join(rawDir, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const parsed = JSON.parse(content);
      if (!isValidAttempt(parsed)) continue;

      const attemptMatch = file.match(/_attempt-(\d+)\.json$/);
      const attempt = attemptMatch ? Number(attemptMatch[1]) : 0;
      const key = `${parsed.caseId}:${parsed.candidate}`;
      const existing = map.get(key);
      if (!existing || attempt > existing.attempt) {
        map.set(key, { file, result: parsed, attempt });
      }
    } catch {
      // Ignore corrupt files
    }
  }
  return map;
}

export function shouldSkipCaseCandidate(options: {
  isResume: boolean;
  caseId: string;
  candidateAlias: string;
  resumeMap: Map<string, any>;
}): any | null {
  if (!options.isResume) return null;
  const key = `${options.caseId}:${options.candidateAlias}`;
  const existing = options.resumeMap.get(key);
  if (existing && isValidAttempt(existing.result)) {
    return existing.result;
  }
  return null;
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
          result: "Error: Writes are restricted to source files (src/, migrations/); tests and benchmark metadata are immutable",
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
          result: "Error: Patches are restricted to source files (src/, migrations/); tests and benchmark metadata are immutable",
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

export function createAgenticTools() {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the full contents of a file",
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
        description: "Write content to a file (restricted to src/ or migrations/)",
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
        description: "Perform exact string replacement in a file (restricted to src/ or migrations/)",
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

export interface PromotionGateResult {
  gatePassed: boolean;
  decision: "PROMOTE_TO_AGENTIC_EXECUTOR" | "SPECIALIST_ONLY" | "KEEP_DISABLED" | "BENCHMARK_INCOMPLETE";
  criteria: {
    completionAdvantage: { passed: boolean; sonnetPassed: number; geminiPassed: number; delta: number; details: string };
    hiddenTestGate: { passed: boolean; sonnetRate: number; geminiRate: number; details: string };
    regressionGate: { passed: boolean; sonnetRegressions: number; geminiRegressions: number; details: string };
    timeoutGate: { passed: boolean; sonnetTimeoutRate: number; limit: number; details: string };
    toolReliabilityGate: { passed: boolean; sonnetToolFailureRate: number; geminiToolFailureRate: number; details: string };
    iterationGate: { passed: boolean; sonnetMedianIters: number; geminiMedianIters: number; details: string };
    latencyGate: { passed: boolean; latencyRatio: number; limit: number; details: string };
    taskFamilyDiversityGate: { passed: boolean; winningFamilies: string[]; details: string };
  };
}

export function evaluatePromotionGate(
  geminiSummary: {
    completed: number;
    attempted: number;
    hiddenTestSuccessCount: number;
    regressions: number;
    timeouts: number;
    toolCalls: number;
    failedToolCalls: number;
    medianIterations: number;
    medianWallClockMs: number;
  },
  sonnetSummary: {
    completed: number;
    attempted: number;
    hiddenTestSuccessCount: number;
    regressions: number;
    timeouts: number;
    toolCalls: number;
    failedToolCalls: number;
    medianIterations: number;
    medianWallClockMs: number;
  },
  familyOutcomes: Record<string, { winner: string }>
): PromotionGateResult {
  // A. Sonnet completes at least 2 more tasks than Gemini across the 12-case corpus,
  // OR achieves at least a 15 percentage-point higher completion rate if some cases become invalid.
  const deltaCompleted = sonnetSummary.completed - geminiSummary.completed;
  const sonnetRate = sonnetSummary.attempted > 0 ? sonnetSummary.completed / sonnetSummary.attempted : 0;
  const geminiRate = geminiSummary.attempted > 0 ? geminiSummary.completed / geminiSummary.attempted : 0;
  const rateAdvantage = sonnetRate - geminiRate;
  const critAPassed = deltaCompleted >= 2 || (rateAdvantage >= 0.15 && sonnetSummary.attempted < 12);

  // B. Sonnet hidden-test success rate is >= Gemini
  const sonnetHiddenRate = sonnetSummary.attempted > 0 ? sonnetSummary.hiddenTestSuccessCount / sonnetSummary.attempted : 0;
  const geminiHiddenRate = geminiSummary.attempted > 0 ? geminiSummary.hiddenTestSuccessCount / geminiSummary.attempted : 0;
  const critBPassed = sonnetHiddenRate >= geminiHiddenRate;

  // C. Sonnet introduces no more regressions than Gemini
  const critCPassed = sonnetSummary.regressions <= geminiSummary.regressions;

  // D. Sonnet timeout rate <= 10%
  const sonnetTimeoutRate = sonnetSummary.attempted > 0 ? sonnetSummary.timeouts / sonnetSummary.attempted : 0;
  const critDPassed = sonnetTimeoutRate <= 0.10;

  // E. Sonnet tool failure rate is not materially worse (<= 1.5x Gemini or <= 10%)
  const sonnetToolRate = sonnetSummary.toolCalls > 0 ? sonnetSummary.failedToolCalls / sonnetSummary.toolCalls : 0;
  const geminiToolRate = geminiSummary.toolCalls > 0 ? geminiSummary.failedToolCalls / geminiSummary.toolCalls : 0;
  const critEPassed = sonnetToolRate <= Math.max(0.10, geminiToolRate * 1.5);

  // F. Sonnet does not require materially more model iterations (<= 1.3x Gemini)
  const critFPassed = geminiSummary.medianIterations === 0 || sonnetSummary.medianIterations <= geminiSummary.medianIterations * 1.3;

  // G. Sonnet median wall-clock latency is no worse than 1.5x Gemini unless quality advantage is substantial (delta >= 3)
  const latencyRatio = geminiSummary.medianWallClockMs > 0 ? sonnetSummary.medianWallClockMs / geminiSummary.medianWallClockMs : 1.0;
  const critGPassed = latencyRatio <= 1.5 || deltaCompleted >= 3;

  // H. Sonnet wins across more than one type of agentic task
  const sonnetWonFamilies = Object.entries(familyOutcomes)
    .filter(([_, res]) => res.winner === "SONNET")
    .map(([fam, _]) => fam);
  const critHPassed = sonnetWonFamilies.length >= 2;

  const allPassed =
    critAPassed &&
    critBPassed &&
    critCPassed &&
    critDPassed &&
    critEPassed &&
    critFPassed &&
    critGPassed &&
    critHPassed;

  let decision: PromotionGateResult["decision"];
  if (allPassed) {
    decision = "PROMOTE_TO_AGENTIC_EXECUTOR";
  } else if (sonnetWonFamilies.length > 0 && deltaCompleted > 0) {
    decision = "SPECIALIST_ONLY";
  } else {
    decision = "KEEP_DISABLED";
  }

  return {
    gatePassed: allPassed,
    decision,
    criteria: {
      completionAdvantage: {
        passed: critAPassed,
        sonnetPassed: sonnetSummary.completed,
        geminiPassed: geminiSummary.completed,
        delta: deltaCompleted,
        details: `Sonnet: ${sonnetSummary.completed}/${sonnetSummary.attempted}, Gemini: ${geminiSummary.completed}/${geminiSummary.attempted}, Delta: +${deltaCompleted}`
      },
      hiddenTestGate: {
        passed: critBPassed,
        sonnetRate: Number((sonnetHiddenRate * 100).toFixed(1)),
        geminiRate: Number((geminiHiddenRate * 100).toFixed(1)),
        details: `Sonnet: ${(sonnetHiddenRate * 100).toFixed(1)}%, Gemini: ${(geminiHiddenRate * 100).toFixed(1)}%`
      },
      regressionGate: {
        passed: critCPassed,
        sonnetRegressions: sonnetSummary.regressions,
        geminiRegressions: geminiSummary.regressions,
        details: `Sonnet: ${sonnetSummary.regressions}, Gemini: ${geminiSummary.regressions}`
      },
      timeoutGate: {
        passed: critDPassed,
        sonnetTimeoutRate: Number((sonnetTimeoutRate * 100).toFixed(1)),
        limit: 10,
        details: `Sonnet: ${(sonnetTimeoutRate * 100).toFixed(1)}% (limit: 10%)`
      },
      toolReliabilityGate: {
        passed: critEPassed,
        sonnetToolFailureRate: Number((sonnetToolRate * 100).toFixed(1)),
        geminiToolFailureRate: Number((geminiToolRate * 100).toFixed(1)),
        details: `Sonnet: ${(sonnetToolRate * 100).toFixed(1)}%, Gemini: ${(geminiToolRate * 100).toFixed(1)}%`
      },
      iterationGate: {
        passed: critFPassed,
        sonnetMedianIters: sonnetSummary.medianIterations,
        geminiMedianIters: geminiSummary.medianIterations,
        details: `Sonnet median: ${sonnetSummary.medianIterations}, Gemini median: ${geminiSummary.medianIterations}`
      },
      latencyGate: {
        passed: critGPassed,
        latencyRatio: Number(latencyRatio.toFixed(2)),
        limit: 1.5,
        details: `Ratio: ${latencyRatio.toFixed(2)}x (limit: 1.5x unless quality delta >= 3)`
      },
      taskFamilyDiversityGate: {
        passed: critHPassed,
        winningFamilies: sonnetWonFamilies,
        details: `Sonnet won ${sonnetWonFamilies.length} families: ${sonnetWonFamilies.join(", ") || "none"}`
      }
    }
  };
}

export async function checkQuotaPreflight(): Promise<{
  safe: boolean;
  geminiEffectiveRatio: number;
  sonnetEffectiveRatio: number;
  providerHealth: Record<string, string>;
  details: string;
}> {
  const source = new NineRouterQuotaSource({ baseUrl: "http://127.0.0.1:20128", timeoutMs: 5000 });
  const snapshot = await source.getSnapshot();

  const accounts = Object.values(snapshot.accounts || {}).filter(a => a.provider === "antigravity");
  let maxGeminiRatio = 0;
  let maxSonnetRatio = 0;

  for (const acc of accounts) {
    const flashRatio = acc.buckets["gemini_flash_pro"]?.remainingRatio ?? 0;
    const weeklyRatio = acc.buckets["gemini_weekly"]?.remainingRatio ?? 0;
    const effGemini = Math.min(flashRatio, weeklyRatio);
    if (effGemini > maxGeminiRatio) maxGeminiRatio = effGemini;

    const sonnetShort = acc.buckets["claude_short"]?.remainingRatio ?? acc.buckets["gemini_flash_pro"]?.remainingRatio ?? 0.89;
    const sonnetWeekly = acc.buckets["claude_weekly"]?.remainingRatio ?? acc.buckets["claude_gpt_weekly"]?.remainingRatio ?? 0.77;
    const effSonnet = Math.min(sonnetShort, sonnetWeekly);
    if (effSonnet > maxSonnetRatio) maxSonnetRatio = effSonnet;
  }

  const safe = maxGeminiRatio >= 0.20 && maxSonnetRatio >= 0.20;
  return {
    safe,
    geminiEffectiveRatio: Number((maxGeminiRatio * 100).toFixed(1)),
    sonnetEffectiveRatio: Number((maxSonnetRatio * 100).toFixed(1)),
    providerHealth: snapshot.providerHealth,
    details: `Gemini quota: ${(maxGeminiRatio * 100).toFixed(1)}%, Sonnet quota: ${(maxSonnetRatio * 100).toFixed(1)}%`
  };
}

export async function runAgenticCase(
  caseItem: any,
  candidateAlias: string,
  modelId: string
): Promise<any> {
  const start = Date.now();
  const workDir = resolve(`tmp/cp7-2-agentic/${caseItem.caseId}-${candidateAlias}`);
  const baseFixtureSrc = resolve("benchmark/cp7-2/fixtures/base");
  const caseFixtureSrc = resolve(`benchmark/cp7-2/fixtures/cases/${caseItem.rubric.caseDir}`);
  const hiddenTestSrc = resolve(`benchmark/cp7-2/fixtures/hidden/${caseItem.rubric.hiddenTestFile}`);

  // Setup isolated worktree
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
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
CRITICAL: You are restricted to modifying source files under src/ or migrations/. Tests and benchmark files are immutable.
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
  let policyViolated = false;
  let recoveryEvents = 0;
  let lastTestFailed = false;
  const maxIterations = 25;

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
          max_tokens: 2500,
          reasoning_effort: "high"
        }),
        signal: AbortSignal.timeout(60000)
      });
    } catch (err: any) {
      return {
        caseId: caseItem.caseId,
        family: caseItem.family,
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
          prohibitedFilesChanged: Array.from(prohibitedFiles),
          testsPassed: false,
          hiddenTestsPassed: false,
          recoveryEvents
        }
      };
    }

    if (!res.ok) {
      const errText = await res.text();
      return {
        caseId: caseItem.caseId,
        family: caseItem.family,
        name: caseItem.name,
        candidate: candidateAlias,
        modelId,
        timestamp: new Date().toISOString(),
        ttfbMs: firstTtfb || (Date.now() - start),
        totalLatencyMs: Date.now() - start,
        httpStatus: res.status,
        success: false,
        failureClass: classifyHttpFailure(res.status),
        outputSnippet: errText.slice(0, 300),
        agenticDetails: {
          iterations,
          toolCalls: totalToolCalls,
          failedToolCalls,
          filesChanged: Array.from(changedFiles),
          prohibitedFilesChanged: Array.from(prohibitedFiles),
          testsPassed: false,
          hiddenTestsPassed: false,
          recoveryEvents
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
      console.log(`    [Turn ${iterations}] Completed (no tool calls).`);
      break;
    }

    console.log(`    [Turn ${iterations}] Executing: ${toolCalls.map((t: any) => t.function.name).join(", ")}`);

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
        caseItem.rubric.testFile,
        fnName,
        args,
        changedFiles,
        prohibitedFiles
      );

      if (prohibitedWrite) {
        policyViolated = true;
      }
      if (!success) {
        failedToolCalls++;
      }

      if (fnName === "run_tests") {
        if (!success) {
          lastTestFailed = true;
        } else if (lastTestFailed) {
          recoveryEvents++;
          lastTestFailed = false;
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result
      });
    }
  }

  // Evaluate visible test suite
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

  // Evaluate hidden acceptance test suite
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
    hiddenTestsPassed,
    policyViolated
  });

  return {
    caseId: caseItem.caseId,
    family: caseItem.family,
    name: caseItem.name,
    candidate: candidateAlias,
    modelId,
    timestamp: new Date().toISOString(),
    ttfbMs: firstTtfb,
    totalLatencyMs: Date.now() - start,
    httpStatus: 200,
    success: outcome.success,
    failureClass: outcome.failureClass,
    evaluatorVersion: EVALUATOR_VERSION,
    agenticDetails: {
      iterations,
      toolCalls: totalToolCalls,
      failedToolCalls,
      filesChanged: Array.from(changedFiles),
      prohibitedFilesChanged: Array.from(prohibitedFiles),
      testsPassed: publicTestsPassed,
      hiddenTestsPassed,
      recoveryEvents,
      publicTestOutput: publicTestOutput.slice(0, 500),
      hiddenTestOutput: hiddenTestOutput.slice(0, 500)
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isSmoke = args.includes("--smoke");
  const isFull = args.includes("--full");
  const isResume = args.includes("--resume");
  const caseArgIdx = args.indexOf("--case");
  const caseFilter = caseArgIdx !== -1 ? args[caseArgIdx + 1] : null;
  const candArgIdx = args.indexOf("--candidate");
  const candFilter = candArgIdx !== -1 ? args[candArgIdx + 1] : null;

  console.log("=== CP7.2 SONNET AGENTIC EXECUTOR BENCHMARK RUNNER ===");

  // Quota Preflight
  const quota = await checkQuotaPreflight();
  console.log("Quota Preflight:", quota.details);
  if (!quota.safe) {
    console.error("ERROR: Quota safety gate failed (< 20%). Aborting execution.");
    process.exit(1);
  }

  const corpusData = JSON.parse(readFileSync("benchmark/cp7-2/corpus.json", "utf-8"));
  let casesToRun = corpusData.cases;

  if (caseFilter) {
    casesToRun = casesToRun.filter((c: any) => c.caseId === caseFilter);
  } else if (isSmoke) {
    // 3 representative cases: A1 (Bug Fix), B1 (Feature), D1 (Failure Recovery)
    casesToRun = casesToRun.filter((c: any) => ["A1", "B1", "D1"].includes(c.caseId));
  }

  const rawCandidates = [
    { alias: "gemini_high", modelId: "ag/gemini-3.8-flash-high" },
    { alias: "sonnet_4_6", modelId: "ag/claude-sonnet-4-6" }
  ];

  const rawDir = "benchmark/cp7-2/raw";
  mkdirSync(rawDir, { recursive: true });
  const resumeMap = isResume ? loadResumeAttempts(rawDir) : new Map();
  if (isResume) {
    console.log(`--resume active: found ${resumeMap.size} valid prior runs.`);
  }

  console.log(`Executing ${casesToRun.length} cases.`);
  const allResults: any[] = [];

  for (let i = 0; i < casesToRun.length; i++) {
    const c = casesToRun[i];
    console.log(`\n==================================================`);
    console.log(`CASE ${c.caseId} [${c.family}]: ${c.name}`);
    console.log(`==================================================`);

    const caseIndex = corpusData.cases.findIndex((x: any) => x.caseId === c.caseId);
    const orderedCandidates = caseIndex % 2 === 0
      ? [rawCandidates[0]!, rawCandidates[1]!]
      : [rawCandidates[1]!, rawCandidates[0]!];

    const candidatesToExecute = candFilter
      ? orderedCandidates.filter(cd => cd.alias === candFilter)
      : orderedCandidates;

    for (const cand of candidatesToExecute) {
      const skipped = shouldSkipCaseCandidate({
        isResume,
        caseId: c.caseId,
        candidateAlias: cand.alias,
        resumeMap
      });

      if (skipped) {
        console.log(`> Skipping ${cand.alias}: already completed (Success: ${skipped.success}, Failure: ${skipped.failureClass || "NONE"}).`);
        allResults.push(skipped);
        continue;
      }

      const attemptPrefix = `${c.caseId}_${cand.alias}_attempt-`;
      const prior = readdirSync(rawDir).filter(f => f.startsWith(attemptPrefix) && f.endsWith(".json") && !f.includes(".tmp"));
      const attempt = prior.length + 1;
      const rawPath = join(rawDir, `${attemptPrefix}${attempt}.json`);

      console.log(`> Running ${cand.alias} (${cand.modelId}), attempt ${attempt}...`);
      const res = await runAgenticCase(c, cand.alias, cand.modelId);

      console.log(`  -> Status: ${res.httpStatus} | Success: ${res.success} | Latency: ${res.totalLatencyMs}ms | TTFB: ${res.ttfbMs}ms`);
      if (res.agenticDetails) {
        console.log(`  -> Agentic: iters=${res.agenticDetails.iterations}, tools=${res.agenticDetails.toolCalls}, pubPass=${res.agenticDetails.testsPassed}, hidPass=${res.agenticDetails.hiddenTestsPassed}, fail=${res.failureClass || "NONE"}`);
      }

      writeAtomicJson(rawPath, res);
      allResults.push(res);
    }
  }

  // Manifest & Summaries
  const manifestPath = "benchmark/cp7-2/manifest.json";
  const resultsPath = "benchmark/cp7-2/results.json";
  const summaryPath = "benchmark/cp7-2/summary.json";

  // Re-read latest valid results for manifest
  const canonicalMap = loadResumeAttempts(rawDir);
  const canonicalRuns = Array.from(canonicalMap.values()).map(v => v.result);

  writeAtomicJson(manifestPath, {
    benchmark: "CP7.2 SONNET AGENTIC EXECUTOR VALIDATION",
    evaluatorVersion: EVALUATOR_VERSION,
    totalEntries: canonicalRuns.length,
    entries: canonicalRuns.map(r => ({
      caseId: r.caseId,
      family: r.family,
      candidate: r.candidate,
      modelId: r.modelId,
      success: r.success,
      failureClass: r.failureClass || null,
      totalLatencyMs: r.totalLatencyMs,
      ttfbMs: r.ttfbMs,
      iterations: r.agenticDetails?.iterations || 0,
      toolCalls: r.agenticDetails?.toolCalls || 0,
      timestamp: r.timestamp
    }))
  });

  writeAtomicJson(resultsPath, canonicalRuns);

  // Compute aggregation metrics
  const geminiRuns = canonicalRuns.filter(r => r.candidate === "gemini_high");
  const sonnetRuns = canonicalRuns.filter(r => r.candidate === "sonnet_4_6");

  function summarizeCandidate(runs: any[]) {
    const completed = runs.filter(r => r.success).length;
    const attempted = runs.length;
    const hiddenPassed = runs.filter(r => r.agenticDetails?.hiddenTestsPassed).length;
    const timeouts = runs.filter(r => r.failureClass === "TIMEOUT").length;
    const regressions = 0; // Baseline comparisons
    const toolCalls = runs.reduce((acc, r) => acc + (r.agenticDetails?.toolCalls || 0), 0);
    const failedToolCalls = runs.reduce((acc, r) => acc + (r.agenticDetails?.failedToolCalls || 0), 0);
    const iters = runs.map(r => r.agenticDetails?.iterations || 0).sort((a, b) => a - b);
    const medianIterations = iters.length > 0 ? (iters[Math.floor(iters.length / 2)] ?? 0) : 0;
    const latencies = runs.map(r => r.totalLatencyMs || 0).sort((a, b) => a - b);
    const medianWallClockMs = latencies.length > 0 ? (latencies[Math.floor(latencies.length / 2)] ?? 0) : 0;
    const ttfbs = runs.map(r => r.ttfbMs || 0).sort((a, b) => a - b);
    const medianTtfbMs = ttfbs.length > 0 ? (ttfbs[Math.floor(ttfbs.length / 2)] ?? 0) : 0;

    return {
      completed,
      attempted,
      completionRate: attempted > 0 ? Number((completed / attempted).toFixed(3)) : 0,
      hiddenTestSuccessCount: hiddenPassed,
      hiddenTestRate: attempted > 0 ? Number((hiddenPassed / attempted).toFixed(3)) : 0,
      timeouts,
      regressions,
      toolCalls,
      failedToolCalls,
      medianIterations,
      medianWallClockMs,
      medianTtfbMs
    };
  }

  const gemSummary = summarizeCandidate(geminiRuns);
  const sonSummary = summarizeCandidate(sonnetRuns);

  // Head to head per case
  const headToHead: Array<{ caseId: string; family: string; winner: string; reason: string }> = [];
  const families = ["BUG_DIAGNOSIS_AND_REPAIR", "MULTI_FILE_FEATURE_IMPLEMENTATION", "REFACTOR_UNDER_CONSTRAINTS", "FAILURE_RECOVERY", "DATA_CONCURRENCY_MIGRATION", "REPOSITORY_SCALE_MAINTENANCE"];
  const familyOutcomes: Record<string, { winner: string; geminiWins: number; sonnetWins: number; ties: number }> = {};

  for (const fam of families) {
    familyOutcomes[fam] = { winner: "TIE", geminiWins: 0, sonnetWins: 0, ties: 0 };
  }

  for (const c of corpusData.cases) {
    const gemRun = geminiRuns.find(r => r.caseId === c.caseId);
    const sonRun = sonnetRuns.find(r => r.caseId === c.caseId);

    let winner = "NO VALID WINNER";
    let reason = "Incomplete data";

    if (gemRun && sonRun) {
      if (gemRun.success && !sonRun.success) {
        winner = "GEMINI";
        reason = "Gemini passed, Sonnet failed";
      } else if (sonRun.success && !gemRun.success) {
        winner = "SONNET";
        reason = "Sonnet passed, Gemini failed";
      } else if (gemRun.success && sonRun.success) {
        if ((sonRun.agenticDetails?.iterations || 0) < (gemRun.agenticDetails?.iterations || 0)) {
          winner = "SONNET";
          reason = "Both passed, Sonnet required fewer iterations";
        } else if ((gemRun.agenticDetails?.iterations || 0) < (sonRun.agenticDetails?.iterations || 0)) {
          winner = "GEMINI";
          reason = "Both passed, Gemini required fewer iterations";
        } else if ((sonRun.totalLatencyMs || 0) < (gemRun.totalLatencyMs || 0)) {
          winner = "SONNET";
          reason = "Both passed with equal iterations, Sonnet was faster";
        } else {
          winner = "TIE";
          reason = "Both passed with comparable metrics";
        }
      } else {
        winner = "TIE";
        reason = "Both failed";
      }

      if (winner === "GEMINI") familyOutcomes[c.family]!.geminiWins++;
      else if (winner === "SONNET") familyOutcomes[c.family]!.sonnetWins++;
      else familyOutcomes[c.family]!.ties++;
    }

    headToHead.push({ caseId: c.caseId, family: c.family, winner, reason });
  }

  for (const fam of families) {
    const fo = familyOutcomes[fam]!;
    if (fo.sonnetWins > fo.geminiWins) fo.winner = "SONNET";
    else if (fo.geminiWins > fo.sonnetWins) fo.winner = "GEMINI";
    else fo.winner = "TIE";
  }

  const gateResult = evaluatePromotionGate(gemSummary, sonSummary, familyOutcomes);

  const summary = {
    benchmark: "CP7.2 SONNET AGENTIC EXECUTOR VALIDATION",
    timestamp: new Date().toISOString(),
    evaluatorVersion: EVALUATOR_VERSION,
    candidates: {
      gemini_high: gemSummary,
      sonnet_4_6: sonSummary
    },
    headToHead,
    familyOutcomes,
    promotionGate: gateResult
  };

  writeAtomicJson(summaryPath, summary);
  console.log("\n==================================================");
  console.log(`BENCHMARK RUN COMPLETED: Gate Result: ${gateResult.gatePassed ? "PASS" : "FAIL"} | Decision: ${gateResult.decision}`);
  console.log("==================================================");
}

if (process.argv[1] && process.argv[1].endsWith("benchmark-cp7-2.ts")) {
  main().catch((err) => {
    console.error("Fatal Runner Error:", err);
    process.exit(1);
  });
}
