import "dotenv/config";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

const candidates = [
  "cx/gpt-5.6-luna",
  "cx/gpt-5.6-sol",
  "cx/gpt-5.6-terra",
  "cx/gpt-6-astra",
  "ag/gemini-3.8-flash-low",
  "ag/gemini-3.8-flash-medium",
  "ag/gemini-3.8-flash-high",
  "ag/claude-sonnet-4-6",
  "ag/claude-opus-4-6-thinking",
  "cx/gpt-5.6-luna-review",
  "cx/gpt-5.6-sol-review",
  "cx/gpt-5.6-terra-review"
];

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
    } catch {
      // ignore partial json
    }
  }
  return { content, model, finishReason, usage };
}

async function probeModel(modelId: string) {
  const start = Date.now();
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
          { role: "user", content: "Explain the difference between optimistic and pessimistic locking in two sentences." }
        ],
        max_tokens: 150
      }),
      signal: AbortSignal.timeout(30000)
    });

    const elapsed = Date.now() - start;
    const contentType = res.headers.get("content-type") || "";

    if (!res.ok) {
      const errText = await res.text();
      return {
        model: modelId,
        status: res.status,
        elapsed,
        error: errText.slice(0, 200)
      };
    }

    if (contentType.includes("text/event-stream")) {
      const rawText = await res.text();
      const parsed = parseSSE(rawText);
      return {
        model: modelId,
        status: res.status,
        elapsed,
        streamed: true,
        returnedModel: parsed.model,
        usage: parsed.usage,
        content: parsed.content.trim().slice(0, 150),
        finishReason: parsed.finishReason
      };
    } else {
      const json = await res.json() as any;
      return {
        model: modelId,
        status: res.status,
        elapsed,
        streamed: false,
        returnedModel: json.model,
        usage: json.usage,
        content: json.choices?.[0]?.message?.content?.trim().slice(0, 150),
        finishReason: json.choices?.[0]?.finish_reason
      };
    }
  } catch (err: any) {
    return {
      model: modelId,
      status: 0,
      elapsed: Date.now() - start,
      error: err.message
    };
  }
}

async function main() {
  console.log("Starting candidate probes against:", baseUrl);
  for (const c of candidates) {
    console.log(`\nProbing ${c}...`);
    const result = await probeModel(c);
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(console.error);
