export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export type EventHandler<T = any> = (payload: T, topic: string) => Promise<void> | void;

export interface EventBusSubscription {
  topic: string;
  unsubscribe: () => void;
}

export interface CacheOptions {
  maxSize: number;
  defaultTtlMs?: number;
}

export interface OrderItem {
  id: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  category: "food" | "electronics" | "clothing" | "general";
}

export interface OrderDiscount {
  code: string;
  type: "percentage" | "fixed_cents";
  value: number;
}

export interface OrderCalculationResult {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  itemCount: number;
}
