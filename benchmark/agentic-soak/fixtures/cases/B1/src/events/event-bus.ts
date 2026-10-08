import { Event, EventHandler, Subscription } from "./types.js";
import { matchesPattern } from "./dispatcher.js";

interface SubRecord {
  id: string;
  pattern: string;
  handler: EventHandler;
}

export class EventBus {
  private subscriptions: SubRecord[] = [];
  private nextId = 1;

  public subscribe(pattern: string, handler: EventHandler): Subscription {
    const id = `sub_${this.nextId++}`;
    const record: SubRecord = { id, pattern, handler };
    this.subscriptions.push(record);

    return {
      id,
      pattern,
      unsubscribe: () => {
        this.subscriptions = this.subscriptions.filter(s => s.id !== id);
      }
    };
  }

  public publish(event: Event): void {
    for (const sub of this.subscriptions) {
      if (matchesPattern(sub.pattern, event.topic)) {
        try {
          sub.handler(event);
        } catch {
          // Swallow subscriber errors to isolate listeners
        }
      }
    }
  }

  public getSubscriberCount(): number {
    return this.subscriptions.length;
  }
}
