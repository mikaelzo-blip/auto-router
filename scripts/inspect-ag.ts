import "dotenv/config";

async function main() {
  const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
  const apiKey = process.env.UPSTREAM_API_KEY || "";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model: "ag/gemini-3.8-flash-low",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10
    })
  });

  console.log("Status:", res.status);
  console.log("Headers:", Object.fromEntries(res.headers.entries()));
  const text = await res.text();
  console.log("Body snippet:\n", text.slice(0, 500));
}

main().catch(console.error);
