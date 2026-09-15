export interface Event<T = any> {
  topic: string;
  payload: T;
  timestamp: number;
}

export type EventHandler<T = any> = (event: Event<T>) => void | Promise<void>;

export interface Subscription {
  id: string;
  pattern: string;
  unsubscribe: () => void;
}
