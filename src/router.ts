import type { ChatCompletionRequest, ChatMessage, RouteDecision, RoutingConfig } from "./types.js";

export interface Classifier {
  classify(text: string, allowedRoutes: string[]): Promise<string | undefined>;
}

export function inspectRequirements(messages: ChatMessage[], tools?: unknown[], functions?: unknown[]) {
  const vision = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: string }).type;
    return type === "image_url" || type === "input_image" || type === "image";
  }));
  return { vision, tools: Boolean(tools?.length || functions?.length) };
}

export function extractRoutingText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) => {
      if (typeof message.content === "string") return [message.content];
      if (!Array.isArray(message.content)) return [];
      return message.content.flatMap((part) => {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return [(part as { text: string }).text];
        return [];
      });
    })
    .join(" ")
    .slice(-12000);
}

const SUPPORTING_WEB_KEYWORDS = new Set([
  "news", "price", "prices", "release", "released", "schedule",
  "berita", "harga", "jadwal", "versi", "rilis", "regulasi", "peraturan", "cuaca", "skor", "pertandingan"
]);

const STRONG_WEB_KEYWORDS = new Set([
  "latest", "today", "current", "recent", "breaking", "web search", "search the web", "current version", "current law",
  "berita hari ini", "berita terbaru", "berita terkini", "hari ini", "terbaru", "terkini", "saat ini",
  "update terbaru", "kabar terbaru", "cari di web", "cari web", "cari internet", "cari online", "riset web",
  "riset internet", "sumber terbaru", "informasi terbaru", "harga hari ini", "harga terbaru", "jadwal terbaru",
  "jadwal hari ini", "versi terbaru", "rilis terbaru", "peraturan terbaru", "undang-undang terbaru"
]);

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function keywordMatches(text: string, keyword: string, route: string): number {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return 0;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
  const matches = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
  if (!matches) return 0;
  if (route === "web-research" && SUPPORTING_WEB_KEYWORDS.has(normalized)) return 1;
  if (route === "web-research" && STRONG_WEB_KEYWORDS.has(normalized)) return 3;
  return normalized.includes(" ") ? 3 : 2;
}

export async function routeRequest(request: ChatCompletionRequest, config: RoutingConfig, classifier?: Classifier): Promise<RouteDecision> {
  const virtual = config.virtualModels[request.model];
  if (!virtual) throw new Error(`Unknown virtual model: ${request.model}`);
  const requirements = inspectRequirements(request.messages, request.tools, request.functions);
  const eligible = config.precedence.filter((name) => supportsRequirements(config.routes[name]!.capabilities, requirements));
  if (virtual.route) {
    const scores = Object.fromEntries(config.precedence.map((name) => [name, 0])) as Record<string, number>;
    if (supportsRequirements(config.routes[virtual.route]!.capabilities, requirements)) {
      return decision(request.model, virtual.route, `explicit virtual model '${request.model}' selected configured route`, "high", false, true, requirements, scores, config);
    }
    if (eligible.length === 0) throw new Error("No configured route supports the requested capabilities");
    const compatibleRoute = requirements.vision && eligible.includes("vision")
      ? "vision"
      : eligible.includes(config.ambiguousFallback) ? config.ambiguousFallback : eligible[0]!;
    return decision(request.model, compatibleRoute, `explicit virtual model '${request.model}' required a capability-compatible route`, "high", false, true, requirements, scores, config);
  }
  const text = normalizeText(extractRoutingText(request.messages));
  if (eligible.length === 0) throw new Error("No configured route supports the requested capabilities");

  if (requirements.vision && config.routes.vision && eligible.includes("vision")) {
    const scores = Object.fromEntries(config.precedence.map((name) => [name, name === "vision" ? 1 : 0])) as Record<string, number>;
    return decision(request.model, "vision", "image content requires a tested vision-capable route", "high", false, false, requirements, scores, config);
  }

  const scores = Object.fromEntries(config.precedence.map((name) => [name, eligible.includes(name)
    ? config.routes[name]!.keywords.reduce((sum, keyword) => sum + keywordMatches(text, keyword, name), 0)
    : -1])) as Record<string, number>;
  const ranked = eligible.map((name) => ({ name, score: scores[name] ?? 0 })).sort((a, b) => b.score - a.score || config.precedence.indexOf(a.name) - config.precedence.indexOf(b.name));
  const first = ranked[0]!;
  const second = ranked[1];
  const decisive = first.score >= 2 && (!second || first.score > second.score);
  if (decisive) return decision(request.model, first.name, `deterministic keyword match (score ${first.score})`, first.score >= 4 ? "high" : "medium", false, false, requirements, scores, config);

  if (classifier && (first.score === 0 || first.score === second?.score)) {
    const classified = await classifier.classify(text, eligible);
    if (classified && eligible.includes(classified)) return decision(request.model, classified, "optional classifier resolved an ambiguous request", "medium", true, false, requirements, scores, config);
  }

  let fallback = first.score >= 2 ? first.name : config.defaultRoute;
  if (!eligible.includes(fallback)) fallback = eligible.includes(config.ambiguousFallback) ? config.ambiguousFallback : eligible[0]!;
  return decision(request.model, fallback, first.score > 0 ? "deterministic precedence resolved tied signals" : "no strong signal; deterministic fallback", "low", false, false, requirements, scores, config);
}

export function supportsRequirements(capabilities: { vision: boolean; tools: boolean }, requirements: { vision: boolean; tools: boolean }): boolean {
  return (!requirements.vision || capabilities.vision) && (!requirements.tools || capabilities.tools);
}

function decision(requestedVirtualModel: string, route: string, reason: string, confidence: RouteDecision["confidence"], classifierUsed: boolean, semanticClassificationBypassed: boolean, requirements: RouteDecision["requirements"], scores: Record<string, number>, config: RoutingConfig): RouteDecision {
  return { requestedVirtualModel, route, upstreamModel: config.routes[route]!.upstreamModel, reason, confidence, classifierUsed, semanticClassificationBypassed, requirements, scores };
}
