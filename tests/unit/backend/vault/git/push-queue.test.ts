import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PushQueue } from "../../../../../src/backend/vault/git/push-queue.js";

interface FakePushResult {
  resolve: (value: void) => void;
  reject: (err: Error) => void;
  calls: number;
}

function fakePusher(): { push: () => Promise<void>; state: FakePushResult } {
  const state: FakePushResult = {
    resolve: () => {},
    reject: () => {},
    calls: 0,
  };
  const push = () => {
    state.calls += 1;
    return new Promise<void>((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
  };
  return { push, state };
}

describe("PushQueue debounce + single-flight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid requests into one push", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    q.request();
    q.request();
    q.request();
    expect(state.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1);
    state.resolve();
    await q.close();
  });

  it("bumps debounce on each request", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    q.request();
    await vi.advanceTimersByTimeAsync(60);
    q.request();
    await vi.advanceTimersByTimeAsync(60);
    // Still not fired — second request reset timer to now+100.
    expect(state.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(state.calls).toBe(1);
    state.resolve();
    await q.close();
  });

  it("single-flight: second push waits for first to finish", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1);
    // Trigger follow-up push while first in-flight.
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1); // still blocked behind in-flight
    state.resolve();
    // Allow microtask queue + scheduled follow-up.
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(2);
    state.resolve();
    await q.close();
  });

  it("close() drains in-flight and cancels pending debounce", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1);
    state.resolve();
    q.request();
    const closed = q.close();
    // Pending debounce cancelled — no new push.
    await vi.advanceTimersByTimeAsync(1000);
    await closed;
    expect(state.calls).toBe(1);
  });
});
