import "dotenv/config";

async function main() {
  const baseUrl = (process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
  const apiKey = process.env.UPSTREAM_API_KEY || "";

  const res = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  });
  if (!res.ok) {
    console.error("Failed to fetch models:", res.status, res.statusText);
    process.exit(1);
  }
  const data = await res.json() as { data: Array<Record<string, any>> };
  console.log(`Discovered ${data.data.length} models from upstream.`);

  const targets = [
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

  for (const target of targets) {
    const found = data.data.find(m => m.id === target);
    if (found) {
      console.log(`FOUND: ${target} ->`, JSON.stringify(found));
    } else {
      console.log(`NOT FOUND: ${target}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
