import "dotenv/config";

const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const apiKey = process.env.UPSTREAM_API_KEY || "";

async function readStreamWithTimeout(stream: ReadableStream<Uint8Array>, idleTimeoutMs = 10000): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Stream idle timeout after ${idleTimeoutMs}ms`)), idleTimeoutMs);
    });

    try {
      const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (done) break;
      if (value) {
        result += decoder.decode(value, { stream: true });
        if (result.includes("[DONE]")) {
          reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      reader.cancel().catch(() => {});
      throw err;
    }
  }

  return result;
}

async function main() {
  console.log("Testing ag/gemini-3.8-flash-medium on case-b1...");
  const prompt = "Fix this TypeScript function so it safely returns undefined when id is undefined or empty string, without throwing or returning invalid profiles. Return only the corrected TypeScript function code:\n\nfunction getUserProfile(users: Map<string, { name: string }>, id?: string) {\n  return users.get(id).name;\n}";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model: "ag/gemini-3.8-flash-low",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      stream: true
    }),
    signal: AbortSignal.timeout(30000)
  });

  console.log("Status:", res.status);
  const text = await res.text();
  console.log("Text length:", text.length, "Snippet:", text.slice(0, 300));
}

main().catch(console.error);
