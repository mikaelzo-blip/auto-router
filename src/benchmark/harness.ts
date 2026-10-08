import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BenchmarkRecord,
  BenchmarkFilterOptions,
  BenchmarkRunSummary,
  TokenUsage
} from "./types.js";
import {
  classifyFailure,
  makeUnitKey,
  redactSensitiveData,
  summarizeBenchmarkRun
} from "./taxonomy.js";
import {
  evaluateCaseOutput,
  runJudgeEvaluation,
  type CorpusCaseItem
} from "./rubrics.js";

export const PRIMARY_CALIBRATION_CANDIDATES = [
  "ag/gemini-3.8-flash-low",
  "ag/gemini-3.8-flash-medium",
  "ag/gemini-3.8-flash-high",
  "cx/gpt-5.6-luna",
  "cx/gpt-5.6-sol",
  "cx/gpt-5.6-terra",
  "cx/gpt-6-astra",
  "ag/claude-sonnet-4-6",
  "ag/claude-opus-4-6-thinking"
] as const;

export const DEFAULT_SUBSET_CASES = ["case-a1", "case-b1", "case-d1", "case-g1", "case-i1"] as const;

export interface BenchmarkRunnerConfig {
  corpusPath?: string;
  outputPath?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultTimeoutMs?: number;
}

export class BenchmarkRunner {
  private corpus: CorpusCaseItem[];
  private outputPath: string;
  private baseUrl: string;
  private apiKey: string;
  private defaultTimeoutMs: number;

  constructor(config: BenchmarkRunnerConfig = {}) {
    const corpusFile = resolve(config.corpusPath ?? "benchmark/corpus.json");
    this.corpus = JSON.parse(readFileSync(corpusFile, "utf8")) as CorpusCaseItem[];
    this.outputPath = resolve(config.outputPath ?? "benchmark/benchmark-results.json");
    this.baseUrl = (config.baseUrl ?? process.env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:20128/v1").replace(/\/$/, "");
    this.apiKey = config.apiKey ?? process.env.UPSTREAM_API_KEY ?? "";
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 40_000;
  }

  public loadCompletedRecords(targetPath = this.outputPath): BenchmarkRecord[] {
    if (existsSync(targetPath)) {
      try {
        const raw = JSON.parse(readFileSync(targetPath, "utf8"));
        if (Array.isArray(raw)) return raw;
        if (raw && Array.isArray(raw.records)) return raw.records;
      } catch {}
    }
    return [];
  }

  public persistRecords(records: BenchmarkRecord[], targetPath = this.outputPath): void {
    const summary = summarizeBenchmarkRun(records);
    writeFileSync(targetPath, JSON.stringify(summary, null, 2));
  }

  private parseSSE(text: string): {
    content: string;
    model: string;
    finishReason: string;
    usage?: TokenUsage;
    timeToFirstByteMs?: number;
  } {
    let content = "";
    let model = "";
    let finishReason = "";
    let usage: TokenUsage | undefined;

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") continue;
      try {
        const data = JSON.parse(dataStr);
        if (data.model) model = data.model;
        if (data.usage) {
          usage = {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0
          };
        }
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (data.choices?.[0]?.finish_reason) finishReason = data.choices[0].finish_reason;
      } catch {}
    }
    return { content, model, finishReason, usage };
  }

  public async executeUnit(params: {
    caseItem: CorpusCaseItem;
    modelId: string;
    attempt: number;
    timeoutMs?: number;
    judgeModel?: string;
  }): Promise<BenchmarkRecord> {
    const { caseItem, modelId, attempt, timeoutMs = this.defaultTimeoutMs, judgeModel } = params;
    const start = Date.now();
    let timeToFirstByteMs: number | undefined;

    const baseRecord: Omit<BenchmarkRecord, "operationalSuccess" | "qualitySuccessWhenExecuted" | "passed"> = {
      caseId: caseItem.caseId,
      category: caseItem.category,
      name: caseItem.name,
      expectedFloor: caseItem.expectedFloor,
      modelId,
      attempt,
      timestamp: new Date().toISOString(),
      httpStatus: 0,
      elapsedMs: 0,
      streamed: false
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const fetchStart = Date.now();
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: caseItem.prompt }],
          max_tokens: 650
        }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));

      timeToFirstByteMs = Date.now() - fetchStart;
      const elapsedMs = Date.now() - start;
      const httpStatus = res.status;

      if (!res.ok) {
        const errorText = await res.text();
        const failureCategory = classifyFailure({
          status: httpStatus,
          errorMessage: errorText
        });

        return {
          ...baseRecord,
          httpStatus,
          elapsedMs,
          timeToFirstByteMs,
          operationalSuccess: false,
          qualitySuccessWhenExecuted: null,
          passed: false,
          failureCategory: failureCategory || "HTTP_5XX",
          failureReason: redactSensitiveData(errorText.slice(0, 250))
        };
      }

      const contentType = res.headers.get("content-type") || "";
      let content = "";
      let usage: TokenUsage | undefined;
      let streamed = false;

      if (contentType.includes("text/event-stream")) {
        const parsed = this.parseSSE(await res.text());
        content = parsed.content;
        usage = parsed.usage;
        streamed = true;
      } else {
        const json = (await res.json()) as any;
        content = json.choices?.[0]?.message?.content || "";
        if (json.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            reasoningTokens: json.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0
          };
        }
      }

      if (!content || content.trim().length === 0) {
        return {
          ...baseRecord,
          httpStatus,
          elapsedMs,
          timeToFirstByteMs,
          streamed,
          usage,
          operationalSuccess: false,
          qualitySuccessWhenExecuted: null,
          passed: false,
          failureCategory: "INVALID_RESPONSE",
          failureReason: "Empty content returned from upstream completion"
        };
      }

      // Operational success! Now evaluate quality:
      const evaluation = evaluateCaseOutput(caseItem, content);
      let judgeResult;

      // Run secondary judge if configured and not self-judging
      if (judgeModel && judgeModel !== modelId) {
        try {
          judgeResult = await runJudgeEvaluation({
            candidateModel: modelId,
            judgeModel,
            c: caseItem,
            candidateOutput: content,
            baseUrl: this.baseUrl,
            apiKey: this.apiKey
          });
        } catch {}
      }

      const qualitySuccess = evaluation.passed;
      const failureCategory = qualitySuccess ? undefined : "QUALITY_FAILURE";
      const failureReason = qualitySuccess ? undefined : evaluation.issues.join("; ");

      return {
        ...baseRecord,
        httpStatus,
        elapsedMs,
        timeToFirstByteMs,
        streamed,
        usage,
        operationalSuccess: true,
        qualitySuccessWhenExecuted: qualitySuccess,
        passed: qualitySuccess,
        failureCategory,
        failureReason,
        contentSnippet: redactSensitiveData(content.slice(0, 200)),
        evaluation,
        judge: judgeResult
      };
    } catch (err: any) {
      const elapsedMs = Date.now() - start;
      const isTimeout = err.name === "AbortError" || err.name === "TimeoutError" || /timeout/i.test(err.message);
      const failureCategory = classifyFailure({
        status: isTimeout ? 504 : 0,
        errorMessage: err.message,
        isTimeout
      });

      return {
        ...baseRecord,
        httpStatus: isTimeout ? 504 : 0,
        elapsedMs,
        timeToFirstByteMs,
        operationalSuccess: false,
        qualitySuccessWhenExecuted: null,
        passed: false,
        failureCategory: failureCategory || (isTimeout ? "INFRA_TIMEOUT" : "HARNESS_ERROR"),
        failureReason: isTimeout ? `Request timed out after ${timeoutMs}ms` : redactSensitiveData(err.message)
      };
    }
  }

  public async run(options: BenchmarkFilterOptions = {}): Promise<BenchmarkRunSummary> {
    const targetOutput = options.outputPath ? resolve(options.outputPath) : this.outputPath;
    const attempts = options.attempts ?? 1;
    const resume = options.resume ?? false;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    // Filter corpus
    let selectedCases = this.corpus;
    if (options.caseIds && options.caseIds.length > 0) {
      selectedCases = selectedCases.filter((c) => options.caseIds!.includes(c.caseId));
    }
    if (options.categories && options.categories.length > 0) {
      selectedCases = selectedCases.filter((c) =>
        options.categories!.some((cat) => c.category.toLowerCase().startsWith(cat.toLowerCase()))
      );
    }

    // Filter models
    let selectedModels: string[] = [...PRIMARY_CALIBRATION_CANDIDATES];
    if (options.models && options.models.length > 0) {
      selectedModels = options.models;
    }

    // Load existing records if resume is enabled
    const existingRecords = resume ? this.loadCompletedRecords(targetOutput) : [];
    const completedKeys = new Set(existingRecords.map((r) => makeUnitKey(r.caseId, r.modelId, r.attempt)));
    const allRecords: BenchmarkRecord[] = [...existingRecords];

    const totalUnits = selectedCases.length * selectedModels.length * attempts;
    let completedCount = completedKeys.size;

    console.log(
      `Starting benchmark: ${selectedCases.length} cases x ${selectedModels.length} models x ${attempts} attempts = ${totalUnits} total units`
    );
    if (resume) {
      console.log(`Resuming with ${existingRecords.length} previously completed records cached.`);
    }

    for (const caseItem of selectedCases) {
      console.log(`\n--- Case: [${caseItem.caseId}] ${caseItem.name} (${caseItem.category}) [Floor: ${caseItem.expectedFloor}] ---`);
      for (const modelId of selectedModels) {
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const unitKey = makeUnitKey(caseItem.caseId, modelId, attempt);
          if (resume && completedKeys.has(unitKey)) {
            const cached = existingRecords.find(
              (r) => r.caseId === caseItem.caseId && r.modelId === modelId && r.attempt === attempt
            );
            console.log(`  [CACHED] ${modelId.padEnd(28)} (att ${attempt}): ${cached?.passed ? "PASS" : cached?.failureCategory ?? "FAIL"}`);
            continue;
          }

          process.stdout.write(`  [RUNNING] ${modelId.padEnd(27)} (att ${attempt}): `);
          const record = await this.executeUnit({
            caseItem,
            modelId,
            attempt,
            timeoutMs,
            judgeModel: options.judgeModel
          });

          allRecords.push(record);
          completedKeys.add(unitKey);
          completedCount++;

          // Immediate persistence of every completed unit
          this.persistRecords(allRecords, targetOutput);

          if (record.operationalSuccess) {
            console.log(
              `${record.passed ? "PASS" : "FAIL (quality)"} | ${record.elapsedMs}ms | in:${record.usage?.promptTokens ?? 0} out:${record.usage?.completionTokens ?? 0} r:${record.usage?.reasoningTokens ?? 0}`
            );
            if (!record.passed && record.failureReason) {
              console.log(`    Issues: ${record.failureReason}`);
            }
          } else {
            console.log(
              `FAIL (op:${record.failureCategory}) ${record.elapsedMs}ms: ${record.failureReason ?? "unknown error"}`
            );
          }
        }
      }
    }

    const summary = summarizeBenchmarkRun(allRecords, selectedModels.length);
    console.log(`\nBenchmark run complete! Total records: ${allRecords.length}/${totalUnits}`);
    console.log(`Operational Success Rate: ${(summary.overallOperationalSuccessRate * 100).toFixed(1)}%`);
    console.log(`Quality Success Rate When Executed: ${(summary.overallQualitySuccessRateWhenExecuted * 100).toFixed(1)}%`);
    console.log(`Denominator Uniform: ${summary.denominatorUniform ? "YES" : "NO"}`);

    return summary;
  }
}
