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
  async archiveOrphans(): Promise<{
    archived: string[];
    failed: Array<{ memoryId: string; path: string; reason: string }>;
  }> {
    return { archived: [], failed: [] };
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

  it("dispatch ignores non-.md paths even if chokidar emits them", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await startPromise;

    const abs = join(root, "workspaces/ws/memories/a.txt");
    await writeFile(abs, "x");
    mock.emit("change", abs);
    await new Promise((r) => setTimeout(r, 20));

    expect(reconciler.calls).toHaveLength(0);
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

  it("'error' event records first error info, doesn't throw", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await startPromise;
    const err = Object.assign(new Error("boom"), { code: "EMFILE" });
    expect(() => mock.emit("error", err)).not.toThrow();
    const info = w.lastError();
    expect(info).not.toBeNull();
    expect(info?.message).toBe("boom");
    expect(info?.code).toBe("EMFILE");
    expect(typeof info?.at).toBe("string");
  });

  it("first error wins; subsequent errors do not overwrite", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    const startPromise = w.start();
    setImmediate(() => mock.emit("ready"));
    await startPromise;
    mock.emit("error", new Error("first"));
    mock.emit("error", new Error("second"));
    expect(w.lastError()?.message).toBe("first");
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
