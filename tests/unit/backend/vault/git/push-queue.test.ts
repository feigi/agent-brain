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

describe("PushQueue backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries according to backoffMs schedule", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({
      push,
      debounceMs: 100,
      backoffMs: [500, 2000],
    });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1);
    state.reject(new Error("boom"));
    // Wait for the rejection to propagate and state to flip to backoff.
    await vi.advanceTimersByTimeAsync(0);

    // No retry before 500ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(2);

    state.reject(new Error("boom again"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(3);
    state.resolve();
    await q.close();
  });

  it("stays at last backoff step after exhausting schedule", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [500] });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    state.reject(new Error("1"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    state.reject(new Error("2"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.calls).toBe(3);
    state.resolve();
    await q.close();
  });

  it("success resets backoff to 0", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({
      push,
      debounceMs: 100,
      backoffMs: [500, 2000],
    });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    state.reject(new Error("1"));
    await vi.advanceTimersByTimeAsync(500);
    state.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // Trigger another push.
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    state.reject(new Error("2"));
    await vi.advanceTimersByTimeAsync(0);
    // Should wait 500ms (attempt=0) again, not 2000ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(state.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(4);
    state.resolve();
    await q.close();
  });

  it("request during backoff does not shorten timer", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [1000] });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    state.reject(new Error("boom"));
    await vi.advanceTimersByTimeAsync(0);
    q.request(); // during backoff
    await vi.advanceTimersByTimeAsync(500);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.calls).toBe(2);
    state.resolve();
    await q.close();
  });
});

describe("PushQueue.unpushedCommits", () => {
  it("delegates to injected counter", async () => {
    const { push } = fakePusher();
    const q = new PushQueue({
      push,
      debounceMs: 100,
      backoffMs: [],
      countUnpushed: async () => 7,
    });
    expect(await q.unpushedCommits()).toBe(7);
    await q.close();
  });

  it("returns 0 when counter throws (no upstream configured)", async () => {
    const { push } = fakePusher();
    const q = new PushQueue({
      push,
      debounceMs: 100,
      backoffMs: [],
      countUnpushed: async () => {
        throw new Error("no upstream");
      },
    });
    expect(await q.unpushedCommits()).toBe(0);
    await q.close();
  });

  it("returns 0 when counter not provided", async () => {
    const { push } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    expect(await q.unpushedCommits()).toBe(0);
    await q.close();
  });
});
