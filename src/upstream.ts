import type { Classifier } from "./router.js";

export class UpstreamClient implements Classifier {
  constructor(private readonly baseUrl: string, private readonly apiKey: string | undefined, private readonly timeoutMs: number, private readonly classifierModel?: string, private readonly classifierTimeoutMs = 5000) {}

  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async chat(body: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: combined });
  }

  async models(signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return fetch(`${this.baseUrl}/models`, { headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  }

  async classify(text: string, allowedRoutes: string[]): Promise<string | undefined> {
    if (!this.classifierModel) return undefined;
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.classifierTimeoutMs),
        body: JSON.stringify({
          model: this.classifierModel,
          temperature: 0,
          max_tokens: 20,
          messages: [
            { role: "system", content: `Return exactly one route name from: ${allowedRoutes.join(", ")}. No explanation.` },
            { role: "user", content: text.slice(0, 4000) }
          ]
        })
      });
      if (!response.ok) return undefined;
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const answer = data.choices?.[0]?.message?.content?.trim().toLowerCase();
      return allowedRoutes.find((route) => answer === route);
    } catch { return undefined; }
  }
}

export function sanitizedUpstreamError(status: number): { error: { message: string; type: string; code: string } } {
  if (status === 400 || status === 422) return { error: { message: "The upstream service rejected the request", type: "upstream_error", code: "upstream_rejected" } };
  if (status === 401 || status === 403) return { error: { message: "Upstream service authentication failed", type: "upstream_error", code: "upstream_authentication" } };
  if (status === 404) return { error: { message: "The requested upstream resource is unavailable", type: "upstream_error", code: "upstream_not_found" } };
  if (status === 429) return { error: { message: "Upstream service is temporarily rate limited", type: "upstream_error", code: "upstream_rate_limited" } };
  return { error: { message: "Upstream service is unavailable", type: "upstream_error", code: "upstream_unavailable" } };
}
