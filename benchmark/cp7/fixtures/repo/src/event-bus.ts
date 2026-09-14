import type { EventHandler, EventBusSubscription } from "./types.js";

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  subscribe<T = any>(topic: string, handler: EventHandler<T>): EventBusSubscription {
    if (!topic || typeof topic !== "string") {
      throw new Error("Invalid topic");
    }
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
    }
    const set = this.handlers.get(topic)!;
    set.add(handler as EventHandler);

    return {
      topic,
      unsubscribe: () => {
        set.delete(handler as EventHandler);
        if (set.size === 0) {
          this.handlers.delete(topic);
        }
      }
    };
  }

  async publish<T = any>(topic: string, payload: T): Promise<number> {
    if (!topic || typeof topic !== "string") {
      throw new Error("Invalid topic");
    }

    let invokedCount = 0;
    const exactHandlers = this.handlers.get(topic);
    if (exactHandlers) {
      for (const handler of Array.from(exactHandlers)) {
        try {
          await handler(payload, topic);
          invokedCount++;
        } catch (err) {
          console.error(`Error in handler for topic ${topic}:`, err);
        }
      }
    }

    return invokedCount;
  }

  clear(): void {
    this.handlers.clear();
  }
}
