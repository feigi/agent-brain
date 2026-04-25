// tests/unit/backend/vault/watcher/boot-scan.test.ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootScan } from "../../../../../src/backend/vault/watcher/boot-scan.js";
import type { Reconciler } from "../../../../../src/backend/vault/watcher/reconciler.js";
import type {
  ReconcileResult,
  ReconcileSignal,
} from "../../../../../src/backend/vault/watcher/types.js";

class StubReconciler implements Reconciler {
  reconcileCalls: Array<{ absPath: string; signal: ReconcileSignal }> = [];
  archiveOrphansCalls: Array<ReadonlySet<string>> = [];
  scriptedResults = new Map<string, ReconcileResult>();

  async reconcileFile(
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<ReconcileResult> {
    this.reconcileCalls.push({ absPath, signal });
    return this.scriptedResults.get(absPath) ?? { action: "indexed" };
  }
  async archiveOrphans(diskPaths: ReadonlySet<string>): Promise<{
    archived: string[];
    failed: Array<{ memoryId: string; path: string; reason: string }>;
  }> {
    this.archiveOrphansCalls.push(diskPaths);
    return { archived: [], failed: [] };
  }
}

describe("runBootScan", () => {
  it("empty vault → all counts zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "ab-bootscan-"));
    try {
      const reconciler = new StubReconciler();
      const result = await runBootScan({ vaultRoot: root, reconciler });
      expect(result).toEqual({
        scanned: 0,
        reconciled: 0,
        orphaned: 0,
        parseErrors: 0,
        embedErrors: 0,
        embedErrorEntries: [],
      });
      expect(reconciler.reconcileCalls).toHaveLength(0);
      expect(reconciler.archiveOrphansCalls).toHaveLength(1);
      expect(reconciler.archiveOrphansCalls[0].size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("walks every .md file under root and counts results", async () => {
    const root = await mkdtemp(join(tmpdir(), "ab-bootscan-"));
    try {
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      const a = join(root, "workspaces/ws/memories/a.md");
      const b = join(root, "workspaces/ws/memories/b.md");
      const c = join(root, "workspaces/ws/memories/c.md");
      await writeFile(a, "x");
      await writeFile(b, "x");
      await writeFile(c, "x");

      const reconciler = new StubReconciler();
      reconciler.scriptedResults.set(a, { action: "indexed" });
      reconciler.scriptedResults.set(b, {
        action: "skipped",
        reason: "hash-and-meta-unchanged",
      });
      reconciler.scriptedResults.set(c, {
        action: "parse-error",
        reason: "boom",
      });

      const result = await runBootScan({ vaultRoot: root, reconciler });

      expect(result.scanned).toBe(3);
      expect(result.reconciled).toBe(2); // indexed + skipped
      expect(result.parseErrors).toBe(1);
      expect(result.embedErrors).toBe(0);
      expect(reconciler.archiveOrphansCalls).toHaveLength(1);
      expect(reconciler.archiveOrphansCalls[0].size).toBe(3);
      // Confirm absolute paths flowed into both APIs.
      expect(reconciler.reconcileCalls.map((c) => c.absPath).sort()).toEqual(
        [a, b, c].sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts thrown errors against embedErrors and continues", async () => {
    const root = await mkdtemp(join(tmpdir(), "ab-bootscan-"));
    try {
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      const a = join(root, "workspaces/ws/memories/a.md");
      const b = join(root, "workspaces/ws/memories/b.md");
      await writeFile(a, "x");
      await writeFile(b, "x");

      const reconciler = new StubReconciler();
      reconciler.reconcileFile = async (absPath, signal) => {
        reconciler.reconcileCalls.push({ absPath, signal });
        if (absPath === a) throw new Error("ollama down");
        return { action: "indexed" };
      };

      const result = await runBootScan({ vaultRoot: root, reconciler });

      expect(result.scanned).toBe(2);
      expect(result.reconciled).toBe(1);
      expect(result.embedErrors).toBe(1);
      expect(result.embedErrorEntries).toEqual([
        { path: a, reason: "ollama down" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
