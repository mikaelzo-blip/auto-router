import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

export const EVALUATOR_VERSION = "agentic-soak-1.0.0";

export interface AgenticSoakResult {
  taskId: string;
  shape: string;
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
  if (
    rel.startsWith("test/") ||
    rel === "test" ||
    rel.startsWith("test-hidden/") ||
    rel === "package.json" ||
    rel.includes("..")
  ) {
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

export async function runAgenticTask(
  task: any,
  model: { id: string; alias: string; name: string }
): Promise<AgenticSoakResult> {
  const start = Date.now();
  const workDir = resolve(`tmp/agentic-soak/agentic-${task.id}-${model.alias}`);
  const baseFixtureSrc = resolve("benchmark/agentic-soak/fixtures/base");
  const caseFixtureSrc = resolve(`benchmark/agentic-soak/fixtures/cases/${task.fixture}`);
  const hiddenTestSrc = resolve(`benchmark/agentic-soak/fixtures/hidden/${task.hiddenTest}`);

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
      // 1 infra retry for network/transport error
      try {
        console.log(`    [Infra Retry] Retrying tool call turn on ${model.alias} due to network error...`);
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
      if (res.status === 429 || res.status >= 500) {
        try {
          console.log(`    [Infra Retry] Retrying tool call turn on ${model.alias} due to HTTP ${res.status}...`);
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
          timeoutOrError = `HTTP error ${res.status} retry failed: ${retryErr.message}`;
          break;
        }
      }
    }

    if (!res.ok) {
      const errText = await res.text();
      timeoutOrError = `HTTP error ${res.status}: ${errText.slice(0, 200)}`;
      break;
    }

    if (iterations === 1) firstTtfb = Date.now() - callStart;

    const data = (await res.json()) as any;
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
    rmSync(hiddenDir, { recursive: true, force: true });
  } catch (err: any) {
    hiddenTestOutput = (err.stdout || "") + "\n" + (err.stderr || "");
    hiddenTestsPassed = false;
  }

  const passed = publicTestsPassed && hiddenTestsPassed;

  // Premature success check
  const lastMsg = messages[messages.length - 1]?.content || "";
  if (
    !passed &&
    /tests? (pass|succeed|all green)|fixed successfully|ready for production|all requirements satisfied/i.test(lastMsg)
  ) {
    prematureSuccess = true;
  }

  const score = passed ? 1.0 : publicTestsPassed ? 0.5 : 0.0;

  return {
    taskId: task.id,
    shape: task.shape,
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
  const modelFilter = args.find((_, i) => args[i - 1] === "--model");
  const resume = args.includes("--resume");
  const smoke = args.includes("--smoke");

  console.log("==================================================");
  console.log("FINAL REAL-WORK AGENTIC SOAK — 12 TASKS X 3 MODELS");
  console.log("==================================================");

  const corpus = JSON.parse(readFileSync("benchmark/agentic-soak/corpus.json", "utf-8"));
  const rawDir = resolve("benchmark/agentic-soak/raw");
  if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });
  const resultsPath = resolve("benchmark/agentic-soak/results.json");

  const resultsMap = new Map<string, AgenticSoakResult>();
  if (existsSync(resultsPath) && resume) {
    const prev = JSON.parse(readFileSync(resultsPath, "utf-8"));
    for (const r of prev.records || []) {
      resultsMap.set(`${r.taskId}::${r.modelAlias}`, r);
    }
    console.log(`Loaded ${resultsMap.size} existing evaluations for resume.`);
  }

  const MODELS = corpus.models as { id: string; alias: string; name: string }[];
  let tasks = corpus.tasks as any[];

  if (smoke) {
    tasks = tasks.slice(0, 1);
    console.log("SMOKE MODE ACTIVE: Running 1 task across models");
  }

  if (taskFilter) {
    tasks = tasks.filter(t => t.id === taskFilter);
  }

  console.log(`\n--- RUNNING AGENTIC SOAK EVALUATION (${tasks.length} tasks x ${MODELS.length} models) ---`);
  for (const task of tasks) {
    console.log(`\n[AGENTIC] ${task.id}: ${task.name} (${task.shape})`);
    for (const model of MODELS) {
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

      console.log(
        `    Result: ${
          res.qualitySuccess ? "ALL GREEN" : res.finalTestsGreen ? "PUBLIC GREEN ONLY" : "FAIL"
        } | Tool Calls: ${res.toolCalls} | Iterations: ${res.iterations} | Latency: ${res.elapsedMs}ms`
      );
      if (res.timeoutOrError) {
        console.log(`    Error/Timeout: ${res.timeoutOrError}`);
      }
      if (res.prematureSuccess) {
        console.log(`    Premature Success Flagged!`);
      }

      writeFileSync(
        resultsPath,
        JSON.stringify(
          {
            version: EVALUATOR_VERSION,
            updatedAt: new Date().toISOString(),
            records: Array.from(resultsMap.values())
          },
          null,
          2
        ),
        "utf-8"
      );
    }
  }

  console.log("\n==================================================");
  console.log("AGENTIC SOAK RUNNER FINISHED");
  console.log("==================================================");
}

main().catch(err => {
  console.error("Fatal runner error:", err);
  process.exit(1);
});
