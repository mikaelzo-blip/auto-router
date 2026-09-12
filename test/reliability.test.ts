import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  StreamLifecycleTracker,
  UpstreamTimeoutError,
  validateTimeoutConfig,
  withStreamTimeouts
} from "../src/reliability.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("reliability foundation", () => {
  it("requires independent positive timeout phases", () => {
    expect(() => validateTimeoutConfig({
      headerTimeoutMs: 0,
      firstByteTimeoutMs: 100,
      streamIdleTimeoutMs: 100
    })).toThrow(/headerTimeoutMs/);

    expect(() => validateTimeoutConfig({
      headerTimeoutMs: 100,
      firstByteTimeoutMs: -1,
      streamIdleTimeoutMs: 100
    })).toThrow(/firstByteTimeoutMs/);

    expect(() => validateTimeoutConfig({
      headerTimeoutMs: 100,
      firstByteTimeoutMs: 100,
      streamIdleTimeoutMs: 0
    })).toThrow(/streamIdleTimeoutMs/);
  });

  it("records explicit stream lifecycle states without prompt data", () => {
    const tracker = new StreamLifecycleTracker();

    tracker.transition("connecting");
    tracker.transition("headers_received");
    tracker.transition("waiting_first_byte");
    tracker.transition("streaming");
    tracker.transition("completed");

    expect(tracker.snapshot()).toMatchObject({
      state: "completed",
      transitions: [
        "connecting",
        "headers_received",
        "waiting_first_byte",
        "streaming",
        "completed"
      ]
    });
    expect(JSON.stringify(tracker.snapshot())).not.toMatch(/secret|prompt|message/i);
  });

  it("fails when the first byte does not arrive", async () => {
    vi.useFakeTimers();
    const tracker = new StreamLifecycleTracker();
    const source = new ReadableStream<Uint8Array>({
      start() {
        return undefined;
      }
    });
    const timed = withStreamTimeouts(source, {
      firstByteTimeoutMs: 25,
      streamIdleTimeoutMs: 50
    }, tracker);
    const read = timed.getReader().read().then(
      () => undefined,
      error => error
    );

    await vi.advanceTimersByTimeAsync(26);

    await expect(read).resolves.toMatchObject({
      code: "first_byte_timeout"
    });
    expect(tracker.snapshot().state).toBe("failed");
  });

  it("fails after an idle gap but not after a healthy long stream", async () => {
    vi.useFakeTimers();
    const tracker = new StreamLifecycleTracker();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      }
    });
    const timed = withStreamTimeouts(source, {
      firstByteTimeoutMs: 25,
      streamIdleTimeoutMs: 50
    }, tracker);
    const reader = timed.getReader();

    const first = reader.read();
    controller.enqueue(new Uint8Array([1]));
    await expect(first).resolves.toMatchObject({ done: false });

    await vi.advanceTimersByTimeAsync(40);
    controller.enqueue(new Uint8Array([2]));
    await expect(reader.read()).resolves.toMatchObject({ done: false });

    await vi.advanceTimersByTimeAsync(49);
    expect(tracker.snapshot().state).toBe("streaming");

    const idleRead = reader.read().then(
      () => undefined,
      error => error
    );
    await vi.advanceTimersByTimeAsync(51);
    await expect(idleRead).resolves.toMatchObject({
      code: "stream_idle_timeout"
    });
  });

  it("uses structured timeout taxonomy", () => {
    const error = new UpstreamTimeoutError("stream_idle_timeout");

    expect(error).toMatchObject({
      name: "UpstreamTimeoutError",
      code: "stream_idle_timeout"
    });
  });
});
