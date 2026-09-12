import type { Classifier } from "./router.js";
import {
  normalizeTimeoutConfig,
  type TimeoutConfig,
  UpstreamTimeoutError
} from "./reliability.js";

export class UpstreamClient implements Classifier {
  private readonly timeoutConfig: TimeoutConfig;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    timeoutConfig: TimeoutConfig | number,
    private readonly classifierModel?: string,
    private readonly classifierTimeoutMs = 5000
  ) {
    this.timeoutConfig = typeof timeoutConfig === "number"
      ? normalizeTimeoutConfig({
          connectTimeoutMs: timeoutConfig,
          headerTimeoutMs: timeoutConfig,
          firstByteTimeoutMs: timeoutConfig,
          streamIdleTimeoutMs: timeoutConfig
        })
      : normalizeTimeoutConfig(timeoutConfig);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
    };
  }

  private async request(
    path: string,
    body: unknown | undefined,
    signal: AbortSignal | undefined,
    timeoutMs = this.timeoutConfig.headerTimeoutMs
  ): Promise<Response> {
    const controller = new AbortController();
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    let callerAbort: (() => void) | undefined;

    const abort = (reason: Error) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };

    if (signal) {
      callerAbort = () => abort(new Error("client_cancelled"));
      if (signal.aborted) callerAbort();
      else signal.addEventListener("abort", callerAbort, { once: true });
    }

    connectTimer = setTimeout(
      () => abort(new UpstreamTimeoutError("connection_timeout")),
      this.timeoutConfig.connectTimeoutMs
    );
    headerTimer = setTimeout(
      () => abort(new UpstreamTimeoutError("header_timeout")),
      timeoutMs
    );

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined
          ? (this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
          : this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      return response;
    } catch (error) {
      if (controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (headerTimer !== undefined) clearTimeout(headerTimer);
      if (signal && callerAbort) signal.removeEventListener("abort", callerAbort);
    }
  }

  async chat(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.request("/chat/completions", body, signal);
  }

  async search(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.request("/search", body, signal, Math.max(this.timeoutConfig.headerTimeoutMs, 20_000));
  }

  async responses(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.request("/responses", body, signal);
  }

  async models(signal?: AbortSignal): Promise<Response> {
    return this.request("/models", undefined, signal);
  }

  async classify(text: string, allowedRoutes: string[]): Promise<string | undefined> {
    if (!this.classifierModel) return undefined;
    try {
      const response = await this.request("/chat/completions", {
        model: this.classifierModel,
        temperature: 0,
        max_tokens: 20,
        messages: [
          { role: "system", content: `Return exactly one route name from: ${allowedRoutes.join(", ")}. No explanation.` },
          { role: "user", content: text.slice(0, 4000) }
        ]
      }, undefined, this.classifierTimeoutMs);
      if (!response.ok) return undefined;
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const answer = data.choices?.[0]?.message?.content?.trim().toLowerCase();
      return allowedRoutes.find((route) => answer === route);
    } catch {
      return undefined;
    }
  }
}

export function sanitizedUpstreamError(status: number): { error: { message: string; type: string; code: string } } {
  if (status === 400 || status === 422) return { error: { message: "The upstream service rejected the request", type: "upstream_error", code: "upstream_rejected" } };
  if (status === 401 || status === 403) return { error: { message: "Upstream service authentication failed", type: "upstream_error", code: "upstream_authentication" } };
  if (status === 404) return { error: { message: "The requested upstream resource is unavailable", type: "upstream_error", code: "upstream_not_found" } };
  if (status === 429) return { error: { message: "Upstream service is temporarily rate limited", type: "upstream_error", code: "upstream_rate_limited" } };
  return { error: { message: "Upstream service is unavailable", type: "upstream_error", code: "upstream_unavailable" } };
}
