import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateCaseOutput, type CorpusCaseItem } from "../../src/benchmark/rubrics.js";

export const HEAD_TO_HEAD_CANDIDATES = [
  "ag/gemini-3.8-flash-high",
  "cx/gpt-5.6-terra",
  "cx/gpt-5.6-sol"
] as const;

export interface HardBenchmarkRecord {
  caseId: string;
  name: string;
  category: string;
  modelId: string;
  attempt: number;
  timestamp: string;
  operationalSuccess: boolean;
  qualitySuccess: boolean;
  passed: boolean;
  failureCategory?: string;
  failureReason?: string;
  elapsedMs: number;
  timeToFirstByteMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  contentSnippet: string;
  evaluation: {
    passed: boolean;
    score: number;
    dimensions: Array<{ name: string; passed: boolean; reason: string }>;
    issues: string[];
  };
}

export interface CandidateMetrics {
  executions: number;
  successfulExecutions: number;
  qualityFailures: number;
  timeouts: number;
  httpFailures: number;
  toolFailures: number;
  averageLatencyMs: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  averageTTFBMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  successRate: string;
  timeoutRate: string;
}

function parseSSE(text: string) {
  let content = "";
  let model = "";
  let finishReason = "";
  let usage: any = null;

  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === "[DONE]") continue;
    try {
      const data = JSON.parse(dataStr);
      if (data.model) model = data.model;
      if (data.usage) usage = data.usage;
      const delta = data.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
      if (data.choices?.[0]?.finish_reason) finishReason = data.choices[0].finish_reason;
    } catch {}
  }
  return { content, model, finishReason, usage };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function p95(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

async function executeSingleUnit(
  caseItem: CorpusCaseItem,
  modelId: string,
  baseUrl: string,
  apiKey: string,
  timeoutMs: number
): Promise<HardBenchmarkRecord> {
  const t0 = Date.now();
  let ttfb = 0;
  let streamed = false;
  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let operationalSuccess = false;
  let failureCategory: string | undefined;
  let failureReason: string | undefined;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: caseItem.prompt }],
        max_tokens: 750
      }),
      signal: ctrl.signal
    });

    ttfb = Date.now() - t0;

    if (!res.ok) {
      operationalSuccess = false;
      failureCategory = `HTTP_${res.status}`;
      failureReason = `Upstream error ${res.status}: ${await res.text()}`;
    } else {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        streamed = true;
        const sse = parseSSE(await res.text());
        content = sse.content;
        if (sse.usage) {
          promptTokens = sse.usage.prompt_tokens ?? 0;
          completionTokens = sse.usage.completion_tokens ?? 0;
          reasoningTokens = sse.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        }
      } else {
        const json = (await res.json()) as any;
        content = json.choices?.[0]?.message?.content || "";
        if (json.usage) {
          promptTokens = json.usage.prompt_tokens ?? 0;
          completionTokens = json.usage.completion_tokens ?? 0;
          reasoningTokens = json.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        }
      }

      if (!content || content.trim().length === 0) {
        operationalSuccess = false;
        failureCategory = "EMPTY_CONTENT";
        failureReason = "Upstream returned empty content";
      } else {
        operationalSuccess = true;
      }
    }
  } catch (err: any) {
    if (err.name === "AbortError" || /timeout/i.test(err.message)) {
      operationalSuccess = false;
      failureCategory = "TIMEOUT";
      failureReason = `Request timed out after ${timeoutMs}ms`;
    } else {
      operationalSuccess = false;
      failureCategory = "FETCH_ERROR";
      failureReason = err.message;
    }
  } finally {
    clearTimeout(timer);
  }

  const elapsedMs = Date.now() - t0;
  if (ttfb === 0) ttfb = elapsedMs;

  let evalResult = { passed: false, score: 0, dimensions: [] as any[], issues: ["Operational failure"] };
  if (operationalSuccess) {
    evalResult = evaluateCaseOutput(caseItem, content);
  }

  const passed = operationalSuccess && evalResult.passed;
  if (!passed && !failureCategory) {
    failureCategory = "QUALITY_FAILURE";
    failureReason = evalResult.issues.join("; ");
  }

  return {
    caseId: caseItem.caseId,
    name: caseItem.name,
    category: caseItem.category,
    modelId,
    attempt: 1,
    timestamp: new Date().toISOString(),
    operationalSuccess,
    qualitySuccess: operationalSuccess ? evalResult.passed : false,
    passed,
    failureCategory,
    failureReason,
    elapsedMs,
    timeToFirstByteMs: ttfb,
    promptTokens,
    completionTokens,
    reasoningTokens,
    contentSnippet: content.slice(0, 200).replace(/\n/g, " "),
    evaluation: evalResult
  };
}

export async function runSolChallengerBenchmark() {
  const corpusPath = resolve("benchmark/sol-hard-corpus.json");
  const outputPath = resolve("benchmark/sol-hard-results.json");
  const summaryPath = resolve("benchmark/sol-hard-summary.json");

  const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
  const apiKey = process.env.UPSTREAM_API_KEY || "";
  const timeoutMs = 75_000;

  const corpus: CorpusCaseItem[] = JSON.parse(readFileSync(corpusPath, "utf8"));

  const args = process.argv.slice(2);
  const startIdx = args.includes("--start") ? parseInt(args[args.indexOf("--start") + 1]!, 10) : 0;
  const count = args.includes("--count") ? parseInt(args[args.indexOf("--count") + 1]!, 10) : corpus.length;
  const reset = args.includes("--reset");

  if (reset && existsSync(outputPath)) {
    unlinkSync(outputPath);
  }

  let existingRecords: HardBenchmarkRecord[] = [];
  if (existsSync(outputPath)) {
    try {
      existingRecords = JSON.parse(readFileSync(outputPath, "utf8"));
    } catch {}
  }
  const completedKeys = new Set(existingRecords.map((r) => `${r.caseId}:${r.modelId}:${r.attempt}`));
  const allRecords: HardBenchmarkRecord[] = [...existingRecords];

  const targetCases = corpus.slice(startIdx, startIdx + count);

  console.log("=== GPT-5.6 SOL HEAVY-REASONING CHALLENGER BENCHMARK ===");
  console.log(`Corpus: ${targetCases.length} cases (from idx ${startIdx} to ${startIdx + targetCases.length - 1})`);
  console.log(`Candidates: ${HEAD_TO_HEAD_CANDIDATES.join(", ")}`);
  console.log(`Timeout per candidate: ${timeoutMs}ms (identical fair deadline)`);
  console.log(`Already completed total records: ${allRecords.length}`);

  for (let idx = 0; idx < targetCases.length; idx++) {
    const caseItem = targetCases[idx]!;
    const globalIdx = startIdx + idx + 1;
    console.log(`\n[${globalIdx}/${corpus.length}] Case: [${caseItem.caseId}] ${caseItem.name}`);

    // Check which models need running
    const modelsToRun = HEAD_TO_HEAD_CANDIDATES.filter(
      (m) => !completedKeys.has(`${caseItem.caseId}:${m}:1`)
    );

    if (modelsToRun.length === 0) {
      for (const m of HEAD_TO_HEAD_CANDIDATES) {
        const cached = allRecords.find((r) => r.caseId === caseItem.caseId && r.modelId === m);
        console.log(`  [CACHED] ${m.padEnd(26)}: ${cached?.passed ? "PASS" : "FAIL"} (${cached?.elapsedMs}ms, score=${cached?.evaluation?.score})`);
      }
      continue;
    }

    // Execute concurrently across models
    console.log(`  Running concurrently on: ${modelsToRun.join(", ")}...`);
    const caseResults = await Promise.all(
      modelsToRun.map((modelId) =>
        executeSingleUnit(caseItem, modelId, baseUrl, apiKey, timeoutMs)
      )
    );

    for (const record of caseResults) {
      allRecords.push(record);
      completedKeys.add(`${record.caseId}:${record.modelId}:1`);
      console.log(
        `  ${record.modelId.padEnd(26)}: ${record.passed ? "PASS" : `FAIL (${record.failureCategory})`} | ${record.elapsedMs}ms | in:${record.promptTokens} out:${record.completionTokens} | score:${record.evaluation.score}`
      );
      if (!record.passed && record.failureReason) {
        console.log(`    Issue: ${record.failureReason.slice(0, 100)}`);
      }
    }

    // Incremental write
    writeFileSync(outputPath, JSON.stringify(allRecords, null, 2));
  }

  // Compute aggregate metrics
  const summary: Record<string, CandidateMetrics> = {};

  for (const modelId of HEAD_TO_HEAD_CANDIDATES) {
    const recs = allRecords.filter((r) => r.modelId === modelId);
    const executions = recs.length;
    const successfulExecutions = recs.filter((r) => r.passed).length;
    const timeouts = recs.filter((r) => r.failureCategory === "TIMEOUT").length;
    const httpFailures = recs.filter((r) => r.failureCategory?.startsWith("HTTP_")).length;
    const qualityFailures = recs.filter((r) => r.operationalSuccess && !r.passed).length;
    const toolFailures = 0;

    const latencies = recs.map((r) => r.elapsedMs);
    const ttfbs = recs.map((r) => r.timeToFirstByteMs);
    const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const avgTTFB = ttfbs.length > 0 ? Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length) : 0;

    const totalInput = recs.reduce((a, b) => a + b.promptTokens, 0);
    const totalOutput = recs.reduce((a, b) => a + b.completionTokens, 0);
    const totalReasoning = recs.reduce((a, b) => a + b.reasoningTokens, 0);

    summary[modelId] = {
      executions,
      successfulExecutions,
      qualityFailures,
      timeouts,
      httpFailures,
      toolFailures,
      averageLatencyMs: avgLatency,
      medianLatencyMs: median(latencies),
      p95LatencyMs: p95(latencies),
      averageTTFBMs: avgTTFB,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalReasoningTokens: totalReasoning,
      successRate: executions > 0 ? `${((successfulExecutions / executions) * 100).toFixed(1)}%` : "0.0%",
      timeoutRate: executions > 0 ? `${((timeouts / executions) * 100).toFixed(1)}%` : "0.0%"
    };
  }

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log("\n=== BENCHMARK SUMMARY ===");
  console.table(summary);
  return summary;
}

if (process.argv[1]?.endsWith("sol-challenger-benchmark.ts")) {
  runSolChallengerBenchmark().catch((err) => {
    console.error("Sol benchmark failed:", err);
    process.exit(1);
  });
}
