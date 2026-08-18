export type RouteName = string;

export interface RouteDefinition {
  upstreamModel: string;
  selectionPriority?: string[];
  description: string;
  capabilities: { vision: boolean; tools: boolean };
  keywords: string[];
}

export interface RoutingConfig {
  virtualModel: string;
  virtualModels: Record<string, { route?: RouteName }>;
  globalFallbackModel: string;
  fallbackPolicy?: {
    statuses: number[];
    availabilityErrorCodes: string[];
  };
  defaultRoute: RouteName;
  ambiguousFallback: RouteName;
  routes: Record<RouteName, RouteDefinition>;
  modelCapabilities: Record<string, { vision: boolean; tools: boolean }>;
  precedence: RouteName[];
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  functions?: unknown[];
  [key: string]: unknown;
}

export interface RouteDecision {
  requestedVirtualModel: string;
  route: RouteName;
  upstreamModel: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  classifierUsed: boolean;
  semanticClassificationBypassed: boolean;
  requirements: { vision: boolean; tools: boolean };
  scores: Record<RouteName, number>;
}
