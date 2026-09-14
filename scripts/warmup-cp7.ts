import "dotenv/config";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

interface WarmupResult {
  modelId: string;
  httpStatus: number;
  ok: boolean;
  ttfbMs: number;
  totalLatencyMs: number;
  streaming: boolean;
  contentSnippet: string;
  returnedModel?: string;
  usage?: any;
  error?: string;
}

async function warmupModel(modelId: string, payloadExtras: Record<string, any> = {}): Promise<WarmupResult> {
  const start = Date.now();
  let ttfbMs = 0;
  let streaming = true;
  let content = "";
  let returnedModel = "";
  let usage: any = null;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with the single word: READY." }],
        max_tokens: 15,
        stream: true,
        ...payloadExtras
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        modelId,
        httpStatus: res.status,
        ok: false,
        ttfbMs: Date.now() - start,
        totalLatencyMs: Date.now() - start,
        streaming: false,
        contentSnippet: "",
        error: errText.slice(0, 300)
      };
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      streaming = false;
      const json = await res.json() as any;
      ttfbMs = Date.now() - start;
      return {
        modelId,
        httpStatus: res.status,
        ok: true,
        ttfbMs,
        totalLatencyMs: Date.now() - start,
        streaming: false,
        contentSnippet: json.choices?.[0]?.message?.content || "",
        returnedModel: json.model,
        usage: json.usage
      };
    }

    if (!res.body) {
      return {
        modelId,
        httpStatus: res.status,
        ok: false,
        ttfbMs: Date.now() - start,
        totalLatencyMs: Date.now() - start,
        streaming: true,
        contentSnippet: "",
        error: "Response body is null"
      };
    }

    const reader = res.body.getReader();
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
          if (parsed.model) returnedModel = parsed.model;
          if (parsed.usage) usage = parsed.usage;
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
        } catch {}
      }
    }

    return {
      modelId,
      httpStatus: res.status,
      ok: true,
      ttfbMs,
      totalLatencyMs: Date.now() - start,
      streaming: true,
      contentSnippet: content.trim(),
      returnedModel,
      usage
    };
  } catch (err: any) {
    return {
      modelId,
      httpStatus: 0,
      ok: false,
      ttfbMs,
      totalLatencyMs: Date.now() - start,
      streaming,
      contentSnippet: "",
      error: err?.message || String(err)
    };
  }
}

async function main() {
  console.log("=== CP7 WARMUP TEST ===");
  const candidates = [
    "ag/gemini-3.8-flash-high",
    "ag/claude-sonnet-4-6",
    "cx/gpt-5.6-sol"
  ];

  for (const c of candidates) {
    console.log(`\nWarming up ${c}...`);
    const r = await warmupModel(c);
    console.log(`Result:`, JSON.stringify(r, null, 2));
  }
}

main().catch(err => {
  console.error("Warmup fatal error:", err);
  process.exit(1);
});
