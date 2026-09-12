export type StreamLifecycleState =
  | "connecting"
  | "headers_received"
  | "waiting_first_byte"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export type TimeoutConfig = {
  connectTimeoutMs: number;
  headerTimeoutMs: number;
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
};

export type TimeoutConfigInput = Partial<TimeoutConfig> & {
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
};

export class UpstreamTimeoutError extends Error {
  readonly code:
    | "connection_timeout"
    | "header_timeout"
    | "first_byte_timeout"
    | "stream_idle_timeout";

  constructor(code: UpstreamTimeoutError["code"]) {
    super(`Upstream ${code.replaceAll("_", " ")}`);
    this.name = "UpstreamTimeoutError";
    this.code = code;
  }
}

export class UpstreamFailureError extends Error {
  constructor(
    readonly code:
      | "connection_failure"
      | "pre_stream_failure"
      | "mid_stream_failure"
      | "client_cancelled",
    message = `Upstream ${code.replaceAll("_", " ")}`
  ) {
    super(message);
    this.name = "UpstreamFailureError";
  }
}

export function validateTimeoutConfig(config: TimeoutConfigInput): void {
  for (const name of [
    "connectTimeoutMs",
    "headerTimeoutMs",
    "firstByteTimeoutMs",
    "streamIdleTimeoutMs"
  ] as const) {
    const value = config[name];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}

export function normalizeTimeoutConfig(config: TimeoutConfigInput): TimeoutConfig {
  validateTimeoutConfig(config);
  return {
    connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
    headerTimeoutMs: config.headerTimeoutMs ?? 30_000,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs
  };
}

export type StreamLifecycleSnapshot = {
  state: StreamLifecycleState;
  transitions: StreamLifecycleState[];
};

const transitions: Record<StreamLifecycleState, StreamLifecycleState[]> = {
  connecting: ["connecting", "headers_received", "failed", "cancelled"],
  headers_received: ["waiting_first_byte", "streaming", "completed", "failed", "cancelled"],
  waiting_first_byte: ["streaming", "completed", "failed", "cancelled"],
  streaming: ["streaming", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export class StreamLifecycleTracker {
  private stateValue: StreamLifecycleState = "connecting";
  private readonly history: StreamLifecycleState[] = [];

  constructor(private readonly onTransition?: (state: StreamLifecycleState) => void) {}

  transition(next: StreamLifecycleState): void {
    if (!transitions[this.stateValue].includes(next)) {
      throw new Error(`Invalid stream lifecycle transition: ${this.stateValue} -> ${next}`);
    }
    this.stateValue = next;
    this.history.push(next);
    this.onTransition?.(next);
  }

  state(): StreamLifecycleState {
    return this.stateValue;
  }

  snapshot(): StreamLifecycleSnapshot {
    return {
      state: this.stateValue,
      transitions: [...this.history]
    };
  }
}

export function withStreamTimeouts(
  source: ReadableStream<Uint8Array>,
  input: TimeoutConfigInput,
  tracker = new StreamLifecycleTracker()
): ReadableStream<Uint8Array> {
  const config = normalizeTimeoutConfig(input);
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstByte = true;
  let settled = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const fail = (error: Error, controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (settled) return;
    settled = true;
    clearTimer();
    if (tracker.state() !== "failed") tracker.transition("failed");
    void reader.cancel(error).catch(() => undefined);
    controller.error(error);
  };

  const armTimer = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    clearTimer();
    const timeout = firstByte ? config.firstByteTimeoutMs : config.streamIdleTimeoutMs;
    const code = firstByte ? "first_byte_timeout" : "stream_idle_timeout";
    timer = setTimeout(() => fail(new UpstreamTimeoutError(code), controller), timeout);
  };

  return new ReadableStream<Uint8Array>({
    start() {
      if (tracker.state() === "connecting") tracker.transition("headers_received");
    },
    async pull(controller) {
      if (settled) return;
      if (firstByte && tracker.state() === "headers_received") {
        tracker.transition("waiting_first_byte");
      }
      armTimer(controller);
      try {
        const result = await reader.read();
        clearTimer();
        if (result.done) {
          settled = true;
          if (tracker.state() !== "completed") tracker.transition("completed");
          controller.close();
          return;
        }
        firstByte = false;
        if (tracker.state() === "waiting_first_byte") tracker.transition("streaming");
        controller.enqueue(result.value);
      } catch (error) {
        fail(
          error instanceof Error
            ? new UpstreamFailureError("mid_stream_failure", error.message)
            : new UpstreamFailureError("mid_stream_failure"),
          controller
        );
      }
    },
    async cancel(reason) {
      if (settled) return;
      settled = true;
      clearTimer();
      if (tracker.state() !== "cancelled") tracker.transition("cancelled");
      await reader.cancel(reason);
    }
  });
}

export function classifyUpstreamError(error: unknown): string {
  if (error instanceof UpstreamTimeoutError) return error.code;
  if (error instanceof UpstreamFailureError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "client_cancelled";
  if (error instanceof Error && error.name === "TimeoutError") return "header_timeout";
  return "connection_failure";
}
