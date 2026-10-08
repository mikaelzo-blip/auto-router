import "dotenv/config";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

const candidates = [
  "ag/gemini-3.8-flash-low",
  "ag/gemini-3.8-flash-medium",
  "ag/gemini-3.8-flash-high",
  "cx/gpt-5.6-luna",
  "cx/gpt-5.6-sol",
  "cx/gpt-5.6-terra",
  "cx/gpt-6-astra",
  "ag/claude-sonnet-4-6",
  "ag/claude-opus-4-6-thinking"
];

const tool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" }
      },
      required: ["city"]
    }
  }
};

function parseSSETool(text: string) {
  let toolCalls: any[] = [];
  let content = "";
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === "[DONE]") continue;
    try {
      const data = JSON.parse(dataStr);
      const delta = data.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    } catch {}
  }
  return { content, toolCalls };
}

async function testTool(model: string) {
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
        messages: [{ role: "user", content: "What is the weather in Tokyo? Call get_weather." }],
        tools: [tool],
        max_tokens: 150
      }),
      signal: AbortSignal.timeout(30000)
    });

    const elapsed = Date.now() - start;
    const contentType = res.headers.get("content-type") || "";

    if (!res.ok) {
      return { model, status: res.status, elapsed, error: (await res.text()).slice(0, 150) };
    }

    if (contentType.includes("text/event-stream")) {
      const parsed = parseSSETool(await res.text());
      return {
        model,
        status: res.status,
        elapsed,
        streamed: true,
        toolCalls: parsed.toolCalls,
        content: parsed.content.slice(0, 80)
      };
    } else {
      const json = await res.json() as any;
      const tc = json.choices?.[0]?.message?.tool_calls;
      return {
        model,
        status: res.status,
        elapsed,
        streamed: false,
        toolCalls: tc,
        content: json.choices?.[0]?.message?.content?.slice(0, 80)
      };
    }
  } catch (err: any) {
    return { model, status: 0, elapsed: Date.now() - start, error: err.message };
  }
}

async function main() {
  for (const c of candidates) {
    const r = await testTool(c);
    console.log(c, "->", JSON.stringify(r));
  }
}

main().catch(console.error);
