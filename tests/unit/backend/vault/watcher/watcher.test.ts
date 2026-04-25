// tests/unit/backend/vault/watcher/watcher.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { stat, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVaultWatcher } from "../../../../../src/backend/vault/watcher/watcher.js";
import type { Reconciler } from "../../../../../src/backend/vault/watcher/reconciler.js";
import type {
  ReconcileResult,
  ReconcileSignal,
} from "../../../../../src/backend/vault/watcher/types.js";

// vi.mock factories are hoisted to the top of the file before any module-level
// variable declarations are evaluated, so module-scope `const` is inaccessible.
// vi.hoisted() is the vitest-recommended escape hatch: its callback runs first
// and can use synchronous require() to pull in Node built-ins.
/* eslint-disable @typescript-eslint/no-require-imports */
const { mockWatcher } = vi.hoisted(() => {
  const { EventEmitter: EE } =
    require("node:events") as typeof import("node:events");
  class MockFSWatcher extends EE {
    closeCalled = false;
    async close() {
      this.closeCalled = true;
    }
  }
  return { mockWatcher: new MockFSWatcher() };
});
/* eslint-enable @typescript-eslint/no-require-imports */

vi.mock("chokidar", () => {
  const watch = vi.fn(() => mockWatcher);
  return {
    default: { watch },
    watch,
    __watcher: mockWatcher,
  };
});

class StubReconciler implements Reconciler {
  calls: Array<{ absPath: string; signal: ReconcileSignal }> = [];
  blockNext: Promise<void> | null = null;
  async reconcileFile(
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<ReconcileResult> {
    this.calls.push({ absPath, signal });
    if (this.blockNext) await this.blockNext;
    return { action: "indexed" };
  }
  async archiveOrphans(): Promise<{ archived: string[] }> {
    return { archived: [] };
  }
}

async function getMockWatcher() {
  const mod = await import("chokidar");
  return (mod as unknown as { __watcher: typeof mockWatcher }).__watcher;
}

describe("createVaultWatcher", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ab-watcher-"));
    await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    // Reset the mock watcher's listeners so each test starts fresh.
    const mock = await getMockWatcher();
    mock.removeAllListeners();
    mock.closeCalled = false;
  });

  it("start() resolves on chokidar 'ready'", async () => {
    const w = createVaultWatcher({
      vaultRoot: root,
      reconciler: new StubReconciler(),
    });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await expect(startPromise).resolves.toBeUndefined();
  });

  it("change event → reconciler called when ignoreSet does not match", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await startPromise;

    const abs = join(root, "workspaces/ws/memories/a.md");
    await writeFile(abs, "x");
    mock.emit("change", abs);
    // Wait for the dispatch microtask + stat to complete.
    await new Promise((r) => setTimeout(r, 20));

    expect(reconciler.calls).toEqual([{ absPath: abs, signal: "change" }]);
  });

  it("change event → reconciler skipped when ignoreSet has matching mtime", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await startPromise;

    const abs = join(root, "workspaces/ws/memories/a.md");
    await writeFile(abs, "x");
    const s = await stat(abs);
    w.ignoreSet.add(abs, Number(s.mtime));

    mock.emit("change", abs);
    await new Promise((r) => setTimeout(r, 20));

    expect(reconciler.calls).toHaveLength(0);
  });

  it("change event → reconciler called when ignoreSet has different mtime (R2)", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await startPromise;

    const abs = join(root, "workspaces/ws/memories/a.md");
    await writeFile(abs, "x");
    w.ignoreSet.add(abs, 1); // intentionally wrong mtime

    mock.emit("change", abs);
    await new Promise((r) => setTimeout(r, 20));

    expect(reconciler.calls).toEqual([{ absPath: abs, signal: "change" }]);
  });

  it("'error' event sets hadError, doesn't throw", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await startPromise;
    expect(() => mock.emit("error", new Error("boom"))).not.toThrow();
    expect(w.hadError()).toBe(true);
  });

  it("stop() awaits in-flight reconciles", async () => {
    const reconciler = new StubReconciler();
    let resolveBlocked: () => void = () => {};
    reconciler.blockNext = new Promise<void>((r) => (resolveBlocked = r));
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await startPromise;

    const abs = join(root, "workspaces/ws/memories/a.md");
    await writeFile(abs, "x");
    mock.emit("change", abs);
    // give the dispatch handler time to enter (stat + ignoreSet check)
    await new Promise((r) => setTimeout(r, 20));

    let stopped = false;
    const stopPromise = w.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);

    resolveBlocked();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(mock.closeCalled).toBe(true);
  });
});
