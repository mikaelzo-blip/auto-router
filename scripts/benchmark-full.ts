import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

interface CorpusCase {
  caseId: string;
  category: string;
  name: string;
  expectedFloor: string;
  prompt: string;
  rubric: {
    type: string;
    mustContain?: string[];
    mustNotContain?: string[];
    keyCriteria: string[];
    maxWords?: number;
  };
}

const corpus: CorpusCase[] = JSON.parse(readFileSync("benchmark/corpus.json", "utf8"));

// Surviving candidates from subset evaluation
const candidates = [
  "ag/gemini-3.8-flash-low",
  "ag/gemini-3.8-flash-medium",
  "cx/gpt-5.6-luna",
  "cx/gpt-5.6-terra",
  "cx/gpt-6-astra"
];

function parseSSE(text: string) {
  let content = "";
  let model = "";
  let finishReason = "";
  let usage: any = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
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

async function runCompletion(model: string, prompt: string, maxTokens = 600) {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(20000)
    });

    const elapsed = Date.now() - start;
    if (!res.ok) {
      return { success: false, status: res.status, elapsed, error: (await res.text()).slice(0, 200) };
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const parsed = parseSSE(await res.text());
      return {
        success: true,
        status: res.status,
        elapsed,
        content: parsed.content,
        usage: parsed.usage,
        streamed: true
      };
    } else {
      const json = await res.json() as any;
      return {
        success: true,
        status: res.status,
        elapsed,
        content: json.choices?.[0]?.message?.content || "",
        usage: json.usage,
        streamed: false
      };
    }
  } catch (err: any) {
    const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      success: false,
      status: isTimeout ? 504 : 0,
      elapsed: Date.now() - start,
      error: isTimeout ? "Timeout (20s)" : err.message
    };
  }
}

function evaluateOutput(c: CorpusCase, output: string) {
  const norm = output.toLowerCase();
  let passed = true;
  const issues: string[] = [];

  if (c.rubric.mustContain) {
    for (const term of c.rubric.mustContain) {
      if (!norm.includes(term.toLowerCase())) {
        passed = false;
        issues.push(`Missing: "${term}"`);
      }
    }
  }

  if (c.rubric.mustNotContain) {
    for (const term of c.rubric.mustNotContain) {
      if (norm.includes(term.toLowerCase())) {
        passed = false;
        issues.push(`Forbidden: "${term}"`);
      }
    }
  }

  return { passed, issues };
}

async function main() {
  console.log(`=== PHASE 7: FULL CORPUS BENCHMARK (${corpus.length} cases x ${candidates.length} candidates) ===`);
  const resultsFile = "benchmark/full-results.json";
  let results: any[] = [];
  if (existsSync(resultsFile)) {
    try {
      results = JSON.parse(readFileSync(resultsFile, "utf8"));
    } catch {}
  }

  let count = 0;
  const total = corpus.length * candidates.length;

  for (const c of corpus) {
    console.log(`\nCase [${c.caseId}] ${c.category} - ${c.name} (Floor: ${c.expectedFloor})`);
    for (const model of candidates) {
      count++;
      const existing = results.find(r => r.caseId === c.caseId && r.model === model);
      if (existing) {
        console.log(`  [${count}/${total} CACHED] ${model.padEnd(28)}: ${existing.passed ? "PASS" : "FAIL"} (${existing.elapsed}ms)`);
        continue;
      }

      process.stdout.write(`  [${count}/${total} RUN]    ${model.padEnd(28)}: `);
      const res = await runCompletion(model, c.prompt);
      if (!res.success) {
        console.log(`FAIL (HTTP ${res.status}, ${res.elapsed}ms): ${res.error}`);
        results.push({
          caseId: c.caseId,
          category: c.category,
          expectedFloor: c.expectedFloor,
          model,
          passed: false,
          error: res.error,
          elapsed: res.elapsed
        });
        writeFileSync(resultsFile, JSON.stringify(results, null, 2));
        continue;
      }

      const evalRes = evaluateOutput(c, res.content || "");
      const promptTokens = res.usage?.prompt_tokens ?? 0;
      const compTokens = res.usage?.completion_tokens ?? 0;
      const reasoningTokens = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

      console.log(`${evalRes.passed ? "PASS" : "FAIL"} | ${res.elapsed}ms | in:${promptTokens} out:${compTokens} r:${reasoningTokens}`);
      if (!evalRes.passed) {
        console.log(`      Issues: ${evalRes.issues.join("; ")}`);
      }

      results.push({
        caseId: c.caseId,
        category: c.category,
        expectedFloor: c.expectedFloor,
        model,
        passed: evalRes.passed,
        issues: evalRes.issues,
        elapsed: res.elapsed,
        promptTokens,
        completionTokens: compTokens,
        reasoningTokens,
        contentSnippet: (res.content || "").slice(0, 150)
      });
      writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    }
  }

  console.log(`\nBenchmark execution completed! Total records: ${results.length}/${total}`);
}

main().catch(console.error);
