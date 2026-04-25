# Vault Backend Phase 5 — Chokidar Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a chokidar-based watcher + pre-listen boot scan that reconciles the lance vector index, `VaultIndex` (path/id map + unindexable list), and open `parse_error` flags against external edits to `<vault>/**/*.md`. Closes the Phase 4d live-edit gap and subsumes the PR #37 deferred `syncPaths` deletion gap.

**Architecture:** Three new modules under `src/backend/vault/watcher/` — `reconciler.ts` (pure logic: parse → diff hash → lance op + index op + flag op), `watcher.ts` (chokidar wrapper + in-flight ignore set with mtime tuple), `boot-scan.ts` (pre-listen vault walk). `VaultBackend.create()` runs boot scan to completion before starting the watcher; `httpServer.listen()` (in `src/server.ts`) only runs after `create()` resolves, so HTTP readiness gating is automatic.

**Tech Stack:** TypeScript, vitest, chokidar (new dep), `@lancedb/lancedb` (existing), `simple-git` (existing). All design decisions D1–D7 are in `docs/superpowers/specs/2026-04-25-vault-backend-phase-5-watcher-design.md`.

---

## File structure

**New files:**

- `src/backend/vault/watcher/types.ts` — `ReconcileSignal`, `ReconcileResult`, `IgnoreSet` interface, `BootScanResult` type
- `src/backend/vault/watcher/ignore-set.ts` — `IgnoreSetImpl` (with mtime tuple), `NoopIgnoreSet`
- `src/backend/vault/watcher/reconciler.ts` — `Reconciler` interface + `createReconciler` factory
- `src/backend/vault/watcher/watcher.ts` — `VaultWatcher` interface + `createVaultWatcher` factory
- `src/backend/vault/watcher/boot-scan.ts` — `runBootScan` function
- `tests/unit/backend/vault/watcher/ignore-set.test.ts`
- `tests/unit/backend/vault/watcher/reconciler.test.ts`
- `tests/unit/backend/vault/watcher/watcher.test.ts`
- `tests/unit/backend/vault/watcher/boot-scan.test.ts`
- `tests/integration/vault-watcher-e2e.test.ts`

**Modified files:**

- `package.json` — add `chokidar` dep
- `src/backend/types.ts` — add `watcher_error?: true` to `BackendSessionStartMeta`
- `src/backend/vault/repositories/memory-files.ts` — accept optional `IgnoreSet` ctor param; record mtime + add to set + schedule release in `edit()`
- `src/backend/vault/repositories/memory-repository.ts` — accept optional `IgnoreSet` ctor param + plumb to `VaultMemoryFiles`
- `src/backend/vault/index.ts` — `VaultBackend.create()`: instantiate ignoreSet, reconciler, runBootScan, watcher.start; `close()`: watcher.stop before pushQueue.close; ctor stores `vaultWatcher`; `sessionStart()` surfaces `watcher_error` from a watcher-error sticky flag
- `tests/contract/repositories/_factories.ts` (and any vault-repo factory used by contract tests) — pass `NoopIgnoreSet` so existing tests don't change behavior

---

## Task 1: Add chokidar dependency

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Verify chokidar not already a dep**

Run: `grep '"chokidar"' /Users/chris/dev/agent-brain/package.json`
Expected: no output (not present)

- [ ] **Step 2: Add chokidar**

Run: `npm install chokidar`

- [ ] **Step 3: Verify install**

Run: `grep '"chokidar"' /Users/chris/dev/agent-brain/package.json`
Expected: one line under `dependencies` showing chokidar with a version pin (e.g. `"chokidar": "^4.0.x"` or `^3.x` — accept whatever npm resolves).

- [ ] **Step 4: Verify import works**

Run: `node -e "import('chokidar').then(m => console.log(typeof m.watch))"`
Expected: `function`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add chokidar dependency for vault watcher

Phase 5 needs chokidar.watch with awaitWriteFinish to debounce
external edits to vault markdown files. Adds the runtime dep; no
code changes yet."
```

---

## Task 2: Watcher types

**Files:**

- Create: `src/backend/vault/watcher/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// src/backend/vault/watcher/types.ts

export type ReconcileSignal = "add" | "change" | "unlink";

export interface ReconcileResult {
  action:
    | "indexed"
    | "reembedded"
    | "meta-updated"
    | "archived"
    | "skipped"
    | "parse-error";
  memoryId?: string;
  reason?: string;
}

export interface IgnoreSet {
  // Record an internal write: absPath + the mtime observed *immediately
  // post-fsync* of our own write. Watcher uses this to skip its own commits.
  add(absPath: string, mtimeAfterWrite: number): void;
  // True only if the path is tracked AND the file's current mtime equals
  // the recorded mtime. mtime mismatch means an external edit collided
  // with our write window — caller should fall through to reconcile.
  has(absPath: string, currentMtime: number): boolean;
  // Schedules deletion of the entry after `graceMs` ms. graceMs must
  // outlast chokidar's awaitWriteFinish.stabilityThreshold so the change
  // event has time to fire and be checked.
  releaseAfter(absPath: string, graceMs: number): void;
}

export interface BootScanResult {
  scanned: number;
  reconciled: number;
  orphaned: number;
  parseErrors: number;
  embedErrors: number;
}
```

- [ ] **Step 2: Verify the file typechecks**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/backend/vault/watcher/types.ts
git commit -m "feat(vault): add Phase 5 watcher type definitions

Pulls ReconcileSignal/ReconcileResult/IgnoreSet/BootScanResult into a
shared types module so reconciler/watcher/boot-scan can compile
independently and unit tests can mock against the interface."
```

---

## Task 3: IgnoreSet implementation — failing test

**Files:**

- Create: `tests/unit/backend/vault/watcher/ignore-set.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// tests/unit/backend/vault/watcher/ignore-set.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  IgnoreSetImpl,
  NoopIgnoreSet,
} from "../../../../../src/backend/vault/watcher/ignore-set.js";

describe("IgnoreSetImpl", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns false for an unknown path", () => {
    const s = new IgnoreSetImpl();
    expect(s.has("/abs/foo.md", 1234567890)).toBe(false);
  });

  it("returns true when path tracked and mtime matches", () => {
    const s = new IgnoreSetImpl();
    s.add("/abs/foo.md", 100);
    expect(s.has("/abs/foo.md", 100)).toBe(true);
  });

  it("returns false when path tracked but mtime differs (external edit collided)", () => {
    const s = new IgnoreSetImpl();
    s.add("/abs/foo.md", 100);
    expect(s.has("/abs/foo.md", 200)).toBe(false);
  });

  it("releaseAfter clears the entry after the grace window", () => {
    const s = new IgnoreSetImpl();
    s.add("/abs/foo.md", 100);
    s.releaseAfter("/abs/foo.md", 500);
    expect(s.has("/abs/foo.md", 100)).toBe(true);
    vi.advanceTimersByTime(499);
    expect(s.has("/abs/foo.md", 100)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.has("/abs/foo.md", 100)).toBe(false);
  });

  it("releaseAfter is a no-op for an untracked path", () => {
    const s = new IgnoreSetImpl();
    expect(() => s.releaseAfter("/abs/missing.md", 500)).not.toThrow();
    vi.advanceTimersByTime(500);
    expect(s.has("/abs/missing.md", 1)).toBe(false);
  });

  it("re-add before grace expiry refreshes mtime + cancels prior release", () => {
    const s = new IgnoreSetImpl();
    s.add("/abs/foo.md", 100);
    s.releaseAfter("/abs/foo.md", 500);
    vi.advanceTimersByTime(300);
    s.add("/abs/foo.md", 200); // overwrite mtime
    s.releaseAfter("/abs/foo.md", 500); // schedule new release
    vi.advanceTimersByTime(400); // total 700ms — original release would have fired at 500
    expect(s.has("/abs/foo.md", 200)).toBe(true);
    vi.advanceTimersByTime(100); // total 800ms — new release fires at 700+500=800
    expect(s.has("/abs/foo.md", 200)).toBe(false);
  });
});

describe("NoopIgnoreSet", () => {
  it("never tracks anything", () => {
    const s = new NoopIgnoreSet();
    s.add("/abs/foo.md", 100);
    expect(s.has("/abs/foo.md", 100)).toBe(false);
    s.releaseAfter("/abs/foo.md", 500);
    expect(s.has("/abs/foo.md", 100)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/backend/vault/watcher/ignore-set.test.ts`
Expected: FAIL — module `ignore-set.js` not found.

---

## Task 4: IgnoreSet implementation — passing impl

**Files:**

- Create: `src/backend/vault/watcher/ignore-set.ts`

- [ ] **Step 1: Implement IgnoreSetImpl + NoopIgnoreSet**

```ts
// src/backend/vault/watcher/ignore-set.ts
import type { IgnoreSet } from "./types.js";

interface Entry {
  mtime: number;
  releaseTimer: NodeJS.Timeout | null;
}

// In-flight write tracker. Mutation sites call add(absPath, mtime) post-fsync,
// then releaseAfter(absPath, graceMs) once the write has fully settled (commit
// + lance write + lock release). Watcher consults has(absPath, currentMtime)
// to decide whether a chokidar event was caused by our own write.
//
// has() compares mtime so an external edit landing during the grace window
// (e.g. user edits the same file between our fsync and grace expiry) is NOT
// silently skipped — caller falls through to reconcile.
export class IgnoreSetImpl implements IgnoreSet {
  private readonly map = new Map<string, Entry>();

  add(absPath: string, mtimeAfterWrite: number): void {
    const existing = this.map.get(absPath);
    if (existing?.releaseTimer) clearTimeout(existing.releaseTimer);
    this.map.set(absPath, { mtime: mtimeAfterWrite, releaseTimer: null });
  }

  has(absPath: string, currentMtime: number): boolean {
    const entry = this.map.get(absPath);
    if (entry === undefined) return false;
    return entry.mtime === currentMtime;
  }

  releaseAfter(absPath: string, graceMs: number): void {
    const entry = this.map.get(absPath);
    if (entry === undefined) return;
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
    entry.releaseTimer = setTimeout(() => {
      this.map.delete(absPath);
    }, graceMs);
    // Allow the process to exit even if releases are pending.
    if (typeof entry.releaseTimer.unref === "function") {
      entry.releaseTimer.unref();
    }
  }
}

// Default for tests / postgres-backend / any path that doesn't run a watcher.
export class NoopIgnoreSet implements IgnoreSet {
  add(): void {}
  has(): boolean {
    return false;
  }
  releaseAfter(): void {}
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `npx vitest run tests/unit/backend/vault/watcher/ignore-set.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/backend/vault/watcher/ignore-set.ts tests/unit/backend/vault/watcher/ignore-set.test.ts
git commit -m "feat(vault): add IgnoreSet for self-write filtering

Mutation sites add(absPath, mtimeAfterWrite) post-fsync; watcher
checks has(absPath, currentMtime). mtime tuple lets an external
edit colliding with our write window fall through to reconcile
instead of being silently skipped."
```

---

## Task 5: Reconciler — happy add path test (no existing row)

**Files:**

- Create: `tests/unit/backend/vault/watcher/reconciler.test.ts`

This is a long file; build it up across the next several tasks. Start with one test for the simplest path.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/backend/vault/watcher/reconciler.test.ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReconciler } from "../../../../../src/backend/vault/watcher/reconciler.js";
import { VaultIndex } from "../../../../../src/backend/vault/repositories/vault-index.js";

// Stubs ----------------------------------------------------------------

class StubVectorIndex {
  rows = new Map<
    string,
    { content_hash: string; archived: boolean; vector: number[] }
  >();
  upsertCalls: Array<{ id: string; content_hash: string }> = [];
  upsertMetaOnlyCalls: string[] = [];
  softArchiveCalls: string[] = [];
  contentHash: string | undefined;

  async upsert(row: {
    id: string;
    vector: number[];
    content_hash: string;
  }): Promise<void> {
    this.upsertCalls.push({ id: row.id, content_hash: row.content_hash });
    this.rows.set(row.id, {
      content_hash: row.content_hash,
      archived: false,
      vector: row.vector,
    });
  }
  async upsertMetaOnly(meta: { id: string }): Promise<void> {
    this.upsertMetaOnlyCalls.push(meta.id);
  }
  async getContentHash(id: string): Promise<string | undefined> {
    return this.rows.get(id)?.content_hash ?? this.contentHash;
  }
  async softArchive(id: string): Promise<void> {
    this.softArchiveCalls.push(id);
    const row = this.rows.get(id);
    if (row) row.archived = true;
  }
  async listAllRowsForOrphanScan(): Promise<
    Array<{ id: string; path: string }>
  > {
    return [];
  }
}

class StubFlagService {
  createCalls: Array<{ memoryId: string; reason: string }> = [];
  resolveCalls: string[] = [];
  openFlags = new Map<string, Array<{ id: string; flag_type: string }>>();

  async hasOpenFlag(memoryId: string, flagType: string): Promise<boolean> {
    return (this.openFlags.get(memoryId) ?? []).some(
      (f) => f.flag_type === flagType,
    );
  }
  async createFlag(input: {
    memoryId: string;
    flagType: string;
    severity: string;
    details: { reason: string };
  }) {
    this.createCalls.push({
      memoryId: input.memoryId,
      reason: input.details.reason,
    });
    return { id: `flag-${this.createCalls.length}` };
  }
  async getFlagsByMemoryId(memoryId: string) {
    return this.openFlags.get(memoryId) ?? [];
  }
  async resolveFlag(flagId: string) {
    this.resolveCalls.push(flagId);
    return { id: flagId };
  }
}

const stubEmbed = async (text: string): Promise<number[]> => {
  // Deterministic: sum of char codes mod 1, 2, 4 — distinct vectors per text.
  const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
  return [seed % 100, (seed * 7) % 100, (seed * 13) % 100, (seed * 17) % 100];
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ab-reconciler-"));
  await mkdir(join(root, "workspaces", "ws"), { recursive: true });
  const vaultIndex = await VaultIndex.create(root);
  const vectorIndex = new StubVectorIndex();
  const flagService = new StubFlagService();
  const reconciler = createReconciler({
    vaultIndex,
    vectorIndex: vectorIndex as any,
    flagService: flagService as any,
    embed: stubEmbed,
    vaultRoot: root,
  });
  return { root, vaultIndex, vectorIndex, flagService, reconciler };
}

const VALID_MD = `---
id: mem-1
title: Test memory
type: pattern
scope: workspace
workspace_id: ws
project_id: proj
author: alice
source: agent-auto
created_at: "2026-04-25T00:00:00.000Z"
updated_at: "2026-04-25T00:00:00.000Z"
embedding_model: stub
embedding_dims: 4
---

# Test memory

Body content.

## Relationships

## Comments
`;

describe("reconciler.reconcileFile add (new row)", () => {
  it("indexes a new file: parse → embed → vectorIndex.upsert → vaultIndex.register", async () => {
    const { root, vaultIndex, vectorIndex, flagService, reconciler } =
      await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      await writeFile(abs, VALID_MD);

      const result = await reconciler.reconcileFile(abs, "add");

      expect(result.action).toBe("indexed");
      expect(result.memoryId).toBe("mem-1");
      expect(vectorIndex.upsertCalls).toHaveLength(1);
      expect(vectorIndex.upsertCalls[0].id).toBe("mem-1");
      expect(vaultIndex.has("mem-1")).toBe(true);
      expect(vaultIndex.get("mem-1")?.path).toBe(
        "workspaces/ws/memories/mem-1.md",
      );
      expect(flagService.createCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: FAIL — `reconciler.js` module not found.

---

## Task 6: Reconciler — minimal impl for add (new row)

**Files:**

- Create: `src/backend/vault/watcher/reconciler.ts`

- [ ] **Step 1: Write minimal impl that passes the new-row add test**

```ts
// src/backend/vault/watcher/reconciler.ts
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { createHash } from "node:crypto";
import type { VaultIndex } from "../repositories/vault-index.js";
import type { VaultVectorIndex } from "../vector/lance-index.js";
import type { FlagService } from "../../../services/flag-service.js";
import { parseMemoryFile } from "../parser/memory-parser.js";
import type { Embedder } from "../session-start.js";
import { logger } from "../../../utils/logger.js";
import type { MemoryScope } from "../../../types/memory.js";
import type { ReconcileResult, ReconcileSignal } from "./types.js";

export interface Reconciler {
  reconcileFile(
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<ReconcileResult>;
  archiveOrphans(
    diskPaths: ReadonlySet<string>,
  ): Promise<{ archived: string[] }>;
}

export interface ReconcilerDeps {
  vaultIndex: VaultIndex;
  vectorIndex: VaultVectorIndex;
  flagService: FlagService;
  embed: Embedder;
  vaultRoot: string;
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  return new ReconcilerImpl(deps);
}

class ReconcilerImpl implements Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  async reconcileFile(
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<ReconcileResult> {
    if (signal === "unlink") {
      // Implemented in a later task — placeholder for now.
      return { action: "skipped", reason: "unlink-not-yet-implemented" };
    }

    const raw = await readFile(absPath, "utf8");
    const parsed = parseMemoryFile(raw);
    const id = parsed.frontmatter.id;
    const body = parsed.body;
    const hash = sha256Hex(body);
    const relPath = relative(this.deps.vaultRoot, absPath);

    const existingHash = await this.deps.vectorIndex.getContentHash(id);
    if (existingHash === undefined) {
      // No row in lance — embed + insert.
      const vector = await this.deps.embed(body);
      await this.deps.vectorIndex.upsert({
        id,
        vector,
        content_hash: hash,
        title: parsed.frontmatter.title,
        scope: parsed.frontmatter.scope as MemoryScope,
        workspace_id: parsed.frontmatter.workspace_id ?? null,
        project_id: parsed.frontmatter.project_id ?? null,
        author: parsed.frontmatter.author,
        archived: false,
      } as never);
      this.deps.vaultIndex.register(id, {
        path: relPath,
        scope: parsed.frontmatter.scope as MemoryScope,
        workspaceId: parsed.frontmatter.workspace_id ?? null,
        userId: parsed.frontmatter.user_id ?? null,
      });
      return { action: "indexed", memoryId: id };
    }

    // Hash compare branch — implemented in next task.
    return { action: "skipped", reason: "change-not-yet-implemented" };
  }

  async archiveOrphans(
    _diskPaths: ReadonlySet<string>,
  ): Promise<{ archived: string[] }> {
    // Implemented in a later task.
    return { archived: [] };
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
```

- [ ] **Step 2: Run test to verify pass**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: PASS — 1 test passes. (Other tests added in later tasks.)

- [ ] **Step 3: Verify the existing test suite is still green**

Run: `npm run test:unit`
Expected: PASS — all unit tests still pass; no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/backend/vault/watcher/reconciler.ts tests/unit/backend/vault/watcher/reconciler.test.ts
git commit -m "feat(vault): reconciler skeleton + add (new row) path

Implements the simplest reconcile path: parse → embed → vector
upsert → vaultIndex.register. change/unlink/parse-error/orphan
branches return placeholders; covered in following commits."
```

---

## Task 7: Reconciler — change with hash-skip + frontmatter-only update

**Files:**

- Modify: `tests/unit/backend/vault/watcher/reconciler.test.ts` (append)
- Modify: `src/backend/vault/watcher/reconciler.ts`

- [ ] **Step 1: Append failing tests for `change` event**

Add to the test file:

```ts
describe("reconciler.reconcileFile change (existing row)", () => {
  it("hash matches + frontmatter unchanged → skipped", async () => {
    const { root, vectorIndex, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      await writeFile(abs, VALID_MD);

      // Seed lance with the exact hash this body produces so the change
      // event sees no body change.
      const sha256Hex = (s: string) =>
        require("node:crypto")
          .createHash("sha256")
          .update(s, "utf8")
          .digest("hex");
      const body =
        "\n# Test memory\n\nBody content.\n\n## Relationships\n\n## Comments\n";
      vectorIndex.rows.set("mem-1", {
        content_hash: sha256Hex(body),
        archived: false,
        vector: [0, 0, 0, 0],
      });

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("skipped");
      expect(vectorIndex.upsertCalls).toHaveLength(0);
      expect(vectorIndex.upsertMetaOnlyCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hash matches but frontmatter changed → upsertMetaOnly", async () => {
    const { root, vectorIndex, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      // Modified title; same body.
      const md = VALID_MD.replace(
        "title: Test memory",
        "title: Renamed memory",
      );
      await writeFile(abs, md);

      const sha256Hex = (s: string) =>
        require("node:crypto")
          .createHash("sha256")
          .update(s, "utf8")
          .digest("hex");
      const body =
        "\n# Test memory\n\nBody content.\n\n## Relationships\n\n## Comments\n";
      vectorIndex.rows.set("mem-1", {
        content_hash: sha256Hex(body),
        archived: false,
        vector: [0, 0, 0, 0],
      });

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("meta-updated");
      expect(vectorIndex.upsertCalls).toHaveLength(0);
      expect(vectorIndex.upsertMetaOnlyCalls).toEqual(["mem-1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hash differs → re-embed + upsert", async () => {
    const { root, vectorIndex, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      await writeFile(abs, VALID_MD);

      vectorIndex.rows.set("mem-1", {
        content_hash: "stale-hash-different-from-body",
        archived: false,
        vector: [0, 0, 0, 0],
      });

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("reembedded");
      expect(vectorIndex.upsertCalls).toHaveLength(1);
      expect(vectorIndex.upsertCalls[0].id).toBe("mem-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (existing skipped/reason mismatch)**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: 1 PASS (new-row add) + 3 FAIL (the new change cases — return value mismatches the placeholder).

- [ ] **Step 3: Implement the change branch**

Replace the `// Hash compare branch — implemented in next task.` block in `reconciler.ts` with:

```ts
// Existing row: compare body hash.
if (existingHash === hash) {
  // Body unchanged. Detect frontmatter change cheaply by comparing the
  // VaultIndex registered entry against parsed values; if anything
  // actionable changed, push a meta-only update.
  const indexEntry = this.deps.vaultIndex.get(id);
  const fmChanged =
    indexEntry === undefined ||
    indexEntry.path !== relPath ||
    indexEntry.scope !== parsed.frontmatter.scope ||
    indexEntry.workspaceId !== (parsed.frontmatter.workspace_id ?? null) ||
    indexEntry.userId !== (parsed.frontmatter.user_id ?? null);
  if (fmChanged) {
    await this.deps.vectorIndex.upsertMetaOnly({
      id,
      title: parsed.frontmatter.title,
      scope: parsed.frontmatter.scope as MemoryScope,
      workspace_id: parsed.frontmatter.workspace_id ?? null,
      project_id: parsed.frontmatter.project_id ?? null,
      author: parsed.frontmatter.author,
      archived: false,
    } as never);
    this.deps.vaultIndex.register(id, {
      path: relPath,
      scope: parsed.frontmatter.scope as MemoryScope,
      workspaceId: parsed.frontmatter.workspace_id ?? null,
      userId: parsed.frontmatter.user_id ?? null,
    });
    return { action: "meta-updated", memoryId: id };
  }
  return { action: "skipped", memoryId: id, reason: "hash-and-meta-unchanged" };
}

// Hash differs — re-embed.
const vector = await this.deps.embed(body);
await this.deps.vectorIndex.upsert({
  id,
  vector,
  content_hash: hash,
  title: parsed.frontmatter.title,
  scope: parsed.frontmatter.scope as MemoryScope,
  workspace_id: parsed.frontmatter.workspace_id ?? null,
  project_id: parsed.frontmatter.project_id ?? null,
  author: parsed.frontmatter.author,
  archived: false,
} as never);
this.deps.vaultIndex.register(id, {
  path: relPath,
  scope: parsed.frontmatter.scope as MemoryScope,
  workspaceId: parsed.frontmatter.workspace_id ?? null,
  userId: parsed.frontmatter.user_id ?? null,
});
return { action: "reembedded", memoryId: id };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/watcher/reconciler.ts tests/unit/backend/vault/watcher/reconciler.test.ts
git commit -m "feat(vault): reconciler change branch with hash-skip

Compare body sha256 against lance content_hash. Match → skip embed
(optionally upsertMetaOnly if frontmatter changed). Differ →
re-embed + full upsert. Saves Ollama calls when only frontmatter
flips (e.g. verified_at bumps)."
```

---

## Task 8: Reconciler — unlink path with reverse lookup

**Files:**

- Modify: `tests/unit/backend/vault/watcher/reconciler.test.ts` (append)
- Modify: `src/backend/vault/watcher/reconciler.ts`

- [ ] **Step 1: Append unlink tests**

```ts
describe("reconciler.reconcileFile unlink", () => {
  it("known path → softArchive lance + unregister vault index + resolve open parse_error flags", async () => {
    const { root, vaultIndex, vectorIndex, flagService, reconciler } =
      await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      vaultIndex.register("mem-1", {
        path: "workspaces/ws/memories/mem-1.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });
      vectorIndex.rows.set("mem-1", {
        content_hash: "h",
        archived: false,
        vector: [1, 1, 1, 1],
      });
      flagService.openFlags.set("mem-1", [
        { id: "f1", flag_type: "parse_error" },
        { id: "f2", flag_type: "duplicate" },
      ]);

      const result = await reconciler.reconcileFile(abs, "unlink");

      expect(result.action).toBe("archived");
      expect(result.memoryId).toBe("mem-1");
      expect(vectorIndex.softArchiveCalls).toEqual(["mem-1"]);
      expect(vaultIndex.has("mem-1")).toBe(false);
      expect(flagService.resolveCalls).toEqual(["f1"]); // only parse_error flag resolved
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unknown path (orphan unlink) → no-op", async () => {
    const { root, vectorIndex, flagService, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/missing.md");
      const result = await reconciler.reconcileFile(abs, "unlink");
      expect(result.action).toBe("skipped");
      expect(vectorIndex.softArchiveCalls).toHaveLength(0);
      expect(flagService.resolveCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: previous 4 PASS + 2 FAIL on unlink behavior (placeholder returns `skipped/unlink-not-yet-implemented`).

- [ ] **Step 3: Implement unlink branch**

Replace the early-return placeholder in `reconcileFile`:

```ts
if (signal === "unlink") {
  const relPath = relative(this.deps.vaultRoot, absPath);
  const memoryId = this.findIdByPath(relPath);
  if (memoryId === null) {
    // Path was never registered (or already cleaned up). Make sure no
    // unindexable entry lingers for it.
    this.deps.vaultIndex.clearUnindexable(relPath);
    return { action: "skipped", reason: "unknown-path" };
  }
  try {
    await this.deps.vectorIndex.softArchive(memoryId);
  } catch (err) {
    logger.error(`reconciler: softArchive failed for ${memoryId}:`, err);
  }
  this.deps.vaultIndex.unregister(memoryId);
  await this.resolveOpenParseErrorFlags(memoryId);
  return { action: "archived", memoryId };
}
```

Then add the helper methods inside the class:

```ts
  private findIdByPath(relPath: string): string | null {
    for (const [id, entry] of this.deps.vaultIndex.entries()) {
      if (entry.path === relPath) return id;
    }
    return null;
  }

  private async resolveOpenParseErrorFlags(memoryId: string): Promise<void> {
    const flags = await this.deps.flagService.getFlagsByMemoryId(memoryId);
    for (const f of flags) {
      if ((f as { flag_type?: string }).flag_type !== "parse_error") continue;
      if ((f as { resolved_at?: unknown }).resolved_at != null) continue;
      try {
        await this.deps.flagService.resolveFlag(
          f.id,
          "agent-brain",
          "fixed" as never,
        );
      } catch (err) {
        logger.warn(
          `reconciler: failed to resolve parse_error flag ${f.id} for ${memoryId}:`,
          err,
        );
      }
    }
  }
```

(Note: the test stub's `resolveFlag` only takes one arg; production `FlagService.resolveFlag(flagId, userId, resolution)` takes three. Stub deliberately ignores extra args.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/watcher/reconciler.ts tests/unit/backend/vault/watcher/reconciler.test.ts
git commit -m "feat(vault): reconciler unlink path with reverse lookup

Reverse-lookup absPath → memoryId via vaultIndex.entries(); soft-
archive lance row, unregister index entry, auto-resolve any open
parse_error flag. Subsumes the PR #37 deferred syncPaths deletion
gap: chokidar 'unlink' fires on git-pull checkouts too."
```

---

## Task 9: Reconciler — parse-error branches

**Files:**

- Modify: `tests/unit/backend/vault/watcher/reconciler.test.ts` (append)
- Modify: `src/backend/vault/watcher/reconciler.ts`

- [ ] **Step 1: Append parse-error tests**

```ts
const BROKEN_FRONTMATTER_MD = `---
this is not yaml: at all: ":
title:
---

body
`;

const VALID_FM_BROKEN_BODY_MD = `---
id: mem-1
title: Test memory
type: pattern
scope: workspace
workspace_id: ws
project_id: proj
author: alice
source: agent-auto
created_at: "2026-04-25T00:00:00.000Z"
updated_at: "2026-04-25T00:00:00.000Z"
embedding_model: stub
embedding_dims: 4
---

(no body heading — parser refuses)
`;

describe("reconciler.reconcileFile parse failures", () => {
  it("frontmatter broken + path NOT in index → vaultIndex.setUnindexable", async () => {
    const { root, vaultIndex, flagService, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/broken.md");
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      await writeFile(abs, BROKEN_FRONTMATTER_MD);

      const result = await reconciler.reconcileFile(abs, "add");

      expect(result.action).toBe("parse-error");
      expect(flagService.createCalls).toHaveLength(0);
      expect(
        vaultIndex.unindexable.find(
          (u) => u.path === "workspaces/ws/memories/broken.md",
        ),
      ).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("body broken + id resolvable + no existing flag → flagService.createFlag", async () => {
    const { root, vaultIndex, flagService, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      await writeFile(abs, VALID_FM_BROKEN_BODY_MD);

      // Pre-register the path so the id-by-path lookup works even when the
      // current parse fails. (Phase 5 only registers on a successful parse;
      // a prior good parse is the realistic scenario here.)
      vaultIndex.register("mem-1", {
        path: "workspaces/ws/memories/mem-1.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("parse-error");
      expect(result.memoryId).toBe("mem-1");
      expect(flagService.createCalls).toHaveLength(1);
      expect(flagService.createCalls[0].memoryId).toBe("mem-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parse failure + id resolvable + flag already open → no duplicate flag", async () => {
    const { root, vaultIndex, flagService, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      await writeFile(abs, VALID_FM_BROKEN_BODY_MD);
      vaultIndex.register("mem-1", {
        path: "workspaces/ws/memories/mem-1.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });
      flagService.openFlags.set("mem-1", [
        { id: "existing", flag_type: "parse_error" },
      ]);

      const result = await reconciler.reconcileFile(abs, "change");

      expect(result.action).toBe("parse-error");
      expect(flagService.createCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parse passes after prior unindexable entry → clearUnindexable", async () => {
    const { root, vaultIndex, reconciler } = await setup();
    try {
      const abs = join(root, "workspaces/ws/memories/mem-1.md");
      await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
      await writeFile(abs, VALID_MD);
      // Seed a stale unindexable entry that should be cleared.
      // VaultIndex exposes setUnindexable as a private method, so simulate
      // through .syncPaths or a direct call. Use the public setUnindexable
      // method if exposed (Phase 4d); otherwise this test asserts via the
      // unindexable getter being empty post-reconcile.
      (
        vaultIndex as unknown as {
          setUnindexable: (path: string, reason: string) => void;
        }
      ).setUnindexable("workspaces/ws/memories/mem-1.md", "previously broken");

      const result = await reconciler.reconcileFile(abs, "add");

      expect(result.action).toBe("indexed");
      expect(
        vaultIndex.unindexable.find(
          (u) => u.path === "workspaces/ws/memories/mem-1.md",
        ),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: previous 6 PASS + 4 FAIL on parse-error behavior.

- [ ] **Step 3: Verify VaultIndex exposes `setUnindexable` / `clearUnindexable` publicly**

Run: `grep -n "setUnindexable\|clearUnindexable" /Users/chris/dev/agent-brain/src/backend/vault/repositories/vault-index.ts`
Expected output includes both method definitions. If currently `private`, change to `public` (no behavior change; producer needs them). If they're already public, skip.

- [ ] **Step 4: Implement parse-error branch**

Wrap the parse step in `reconcileFile` with a try/catch and add the success-path side-effect for clearing prior unindexable entries. Replace the body of `reconcileFile` after the `if (signal === "unlink")` block:

```ts
const raw = await readFile(absPath, "utf8");
const relPath = relative(this.deps.vaultRoot, absPath);
let parsed: ReturnType<typeof parseMemoryFile>;
try {
  parsed = parseMemoryFile(raw);
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  const memoryId = this.findIdByPath(relPath);
  if (memoryId === null) {
    // No id resolvable → record as unindexable so it surfaces in
    // BackendSessionStartMeta.parse_errors next sessionStart.
    this.deps.vaultIndex.setUnindexable(relPath, reason);
    return { action: "parse-error", reason };
  }
  // id resolvable → produce a parse_error flag (idempotent).
  const already = await this.deps.flagService.hasOpenFlag(
    memoryId,
    "parse_error",
  );
  if (!already) {
    try {
      await this.deps.flagService.createFlag({
        memoryId,
        flagType: "parse_error",
        severity: "needs_review",
        details: { reason: `Parse error in ${relPath}: ${reason}` },
      });
    } catch (writeErr) {
      logger.warn(
        `reconciler: createFlag(parse_error) failed for ${memoryId}:`,
        writeErr,
      );
    }
  }
  return { action: "parse-error", memoryId, reason };
}

// Successful parse — clear any stale unindexable entry that was
// tracking this path while it was broken.
this.deps.vaultIndex.clearUnindexable(relPath);

const id = parsed.frontmatter.id;
// ... existing body (existingHash check, hash compare, etc.)
```

After the existing-row hash branch logic, **also auto-resolve any open `parse_error` flag** for the now-good file. Add a call right before each successful return (`indexed`, `meta-updated`, `reembedded`, `skipped` for hash-and-meta-unchanged):

```ts
await this.resolveOpenParseErrorFlags(id);
```

…or factor by computing the result first, calling `resolveOpenParseErrorFlags`, then returning. Cleanest:

```ts
const result = await this.applySuccessfulParse(parsed, hash, relPath);
await this.resolveOpenParseErrorFlags(parsed.frontmatter.id);
return result;
```

…and extract the hash-compare/upsert block into `applySuccessfulParse`. Either factoring is fine; pick the one that keeps the diff smallest.

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: 10 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/vault/watcher/reconciler.ts tests/unit/backend/vault/watcher/reconciler.test.ts src/backend/vault/repositories/vault-index.ts
git commit -m "feat(vault): reconciler parse-error branches

Parse failure with id resolvable → flagService.createFlag (skipped
when already open). Parse failure without id → vaultIndex.set-
Unindexable. Successful parse on previously-broken file auto-
resolves the open parse_error flag and clears the unindexable
entry. Closes the Phase 4d live-edit gap."
```

---

## Task 10: Reconciler — archiveOrphans

**Files:**

- Modify: `tests/unit/backend/vault/watcher/reconciler.test.ts` (append)
- Modify: `src/backend/vault/watcher/reconciler.ts`

- [ ] **Step 1: Append archiveOrphans test**

```ts
describe("reconciler.archiveOrphans", () => {
  it("soft-archives lance rows whose path is not in diskPaths", async () => {
    const { root, vaultIndex, vectorIndex, reconciler } = await setup();
    try {
      // Three rows in lance, two paths on disk.
      vaultIndex.register("a", {
        path: "workspaces/ws/memories/a.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });
      vaultIndex.register("b", {
        path: "workspaces/ws/memories/b.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });
      vaultIndex.register("c", {
        path: "workspaces/ws/memories/c.md",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
      });
      vectorIndex.rows.set("a", {
        content_hash: "h",
        archived: false,
        vector: [],
      });
      vectorIndex.rows.set("b", {
        content_hash: "h",
        archived: false,
        vector: [],
      });
      vectorIndex.rows.set("c", {
        content_hash: "h",
        archived: false,
        vector: [],
      });

      // Override listAllRowsForOrphanScan stub.
      (
        vectorIndex as unknown as {
          listAllRowsForOrphanScan: () => Promise<
            Array<{ id: string; path: string }>
          >;
        }
      ).listAllRowsForOrphanScan = async () => [
        { id: "a", path: "workspaces/ws/memories/a.md" },
        { id: "b", path: "workspaces/ws/memories/b.md" },
        { id: "c", path: "workspaces/ws/memories/c.md" },
      ];

      const diskPaths = new Set([
        join(root, "workspaces/ws/memories/a.md"),
        join(root, "workspaces/ws/memories/b.md"),
      ]);
      const { archived } = await reconciler.archiveOrphans(diskPaths);

      expect(archived).toEqual(["c"]);
      expect(vectorIndex.softArchiveCalls).toEqual(["c"]);
      expect(vaultIndex.has("c")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts -t archiveOrphans`
Expected: FAIL — placeholder returns empty array.

- [ ] **Step 3: Verify `VaultVectorIndex.listAllRowsForOrphanScan` exists; add if missing**

Run: `grep -n "listAllRowsForOrphanScan\|listAllRows\|allRows" /Users/chris/dev/agent-brain/src/backend/vault/vector/lance-index.ts`

If no method returning `Array<{id, path}>` for non-archived rows exists, add one. Implementation sketch:

```ts
  // Returns id + path for every non-archived row. Used by the boot
  // reconciler to detect lance rows whose markdown file no longer exists
  // on disk (orphan archival).
  async listAllRowsForOrphanScan(): Promise<Array<{ id: string; path: string }>> {
    const rows = await this.tbl
      .query()
      .where("archived = false")
      .select(["id", "path"])
      .toArray();
    return rows.map((r) => ({ id: String(r.id), path: String(r.path) }));
  }
```

(Adapt method/property names to whatever `VaultVectorIndex` actually uses — check the file first.)

- [ ] **Step 4: Implement archiveOrphans in reconciler**

```ts
  async archiveOrphans(diskPaths: ReadonlySet<string>): Promise<{ archived: string[] }> {
    const rows = await this.deps.vectorIndex.listAllRowsForOrphanScan();
    const archived: string[] = [];
    for (const { id, path: relPath } of rows) {
      const abs = `${this.deps.vaultRoot}/${relPath}`;
      // Compare the absolute path so callers can pass either fs.realpath-
      // resolved entries or join-ed entries — both work as long as the
      // caller is consistent.
      if (diskPaths.has(abs)) continue;
      try {
        await this.deps.vectorIndex.softArchive(id);
        this.deps.vaultIndex.unregister(id);
        archived.push(id);
      } catch (err) {
        logger.error(
          `reconciler: archiveOrphans failed for ${id} (path=${relPath}):`,
          err,
        );
      }
    }
    return { archived };
  }
```

- [ ] **Step 5: Run test to verify pass**

Run: `npx vitest run tests/unit/backend/vault/watcher/reconciler.test.ts`
Expected: 11 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/vault/watcher/reconciler.ts src/backend/vault/vector/lance-index.ts tests/unit/backend/vault/watcher/reconciler.test.ts
git commit -m "feat(vault): reconciler archiveOrphans for boot reconcile

Boot scan calls archiveOrphans(diskPaths) after walking every
markdown file. Rows in lance whose path is no longer on disk get
soft-archived and unregistered. Closes lance↔markdown drift left
over from any earlier crash."
```

---

## Task 11: Boot scan — happy-path test

**Files:**

- Create: `tests/unit/backend/vault/watcher/boot-scan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/backend/vault/watcher/boot-scan.test.ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootScan } from "../../../../../src/backend/vault/watcher/boot-scan.js";
import type { Reconciler } from "../../../../../src/backend/vault/watcher/reconciler.js";

class StubReconciler implements Reconciler {
  reconcileCalls: Array<{ absPath: string; signal: string }> = [];
  archiveOrphansCalls: Array<ReadonlySet<string>> = [];
  scriptedResults = new Map<string, { action: string; reason?: string }>();

  async reconcileFile(absPath: string, signal: "add" | "change" | "unlink") {
    this.reconcileCalls.push({ absPath, signal });
    const r = this.scriptedResults.get(absPath) ?? { action: "indexed" };
    return r as never;
  }
  async archiveOrphans(diskPaths: ReadonlySet<string>) {
    this.archiveOrphansCalls.push(diskPaths);
    return { archived: [] };
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
      expect(result.reconciled).toBe(2); // indexed + skipped count as reconciled
      expect(result.parseErrors).toBe(1);
      expect(result.embedErrors).toBe(0);
      expect(reconciler.archiveOrphansCalls).toHaveLength(1);
      expect(reconciler.archiveOrphansCalls[0].size).toBe(3);
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
      // Make the first file throw.
      reconciler.reconcileFile = async (
        absPath: string,
        signal: "add" | "change" | "unlink",
      ) => {
        reconciler.reconcileCalls.push({ absPath, signal });
        if (absPath === a) throw new Error("ollama down");
        return { action: "indexed" } as never;
      };

      const result = await runBootScan({ vaultRoot: root, reconciler });

      expect(result.scanned).toBe(2);
      expect(result.reconciled).toBe(1);
      expect(result.embedErrors).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/backend/vault/watcher/boot-scan.test.ts`
Expected: FAIL — module not found.

---

## Task 12: Boot scan — implementation

**Files:**

- Create: `src/backend/vault/watcher/boot-scan.ts`

- [ ] **Step 1: Implement runBootScan**

```ts
// src/backend/vault/watcher/boot-scan.ts
import { listMarkdownFiles } from "../io/vault-fs.js";
import { logger } from "../../../utils/logger.js";
import type { Reconciler } from "./reconciler.js";
import type { BootScanResult } from "./types.js";

export interface RunBootScanOpts {
  vaultRoot: string;
  reconciler: Reconciler;
}

// Walks every markdown file under <vaultRoot>, calls
// reconciler.reconcileFile(path, "add") per file, then archives lance rows
// whose path is no longer on disk. Blocks until consistent so HTTP listen
// only happens once vault state is in agreement.
export async function runBootScan(
  opts: RunBootScanOpts,
): Promise<BootScanResult> {
  const { vaultRoot, reconciler } = opts;
  const paths = await listMarkdownFiles(vaultRoot);

  let reconciled = 0;
  let parseErrors = 0;
  let embedErrors = 0;
  const diskPaths = new Set<string>();

  for (const abs of paths) {
    diskPaths.add(abs);
    try {
      const result = await reconciler.reconcileFile(abs, "add");
      switch (result.action) {
        case "indexed":
        case "reembedded":
        case "meta-updated":
        case "skipped":
          reconciled++;
          break;
        case "parse-error":
          parseErrors++;
          break;
        case "archived":
          // unlink-style result on a still-on-disk file shouldn't happen via
          // an "add" signal, but log + count as reconciled to be safe.
          reconciled++;
          break;
      }
    } catch (err) {
      embedErrors++;
      logger.error(`runBootScan: reconcile failed for ${abs}:`, err);
    }
  }

  const orphan = await reconciler.archiveOrphans(diskPaths);

  return {
    scanned: paths.length,
    reconciled,
    orphaned: orphan.archived.length,
    parseErrors,
    embedErrors,
  };
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `npx vitest run tests/unit/backend/vault/watcher/boot-scan.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 3: Run the full suite**

Run: `npm run test:unit`
Expected: PASS — all unit tests still green.

- [ ] **Step 4: Commit**

```bash
git add src/backend/vault/watcher/boot-scan.ts tests/unit/backend/vault/watcher/boot-scan.test.ts
git commit -m "feat(vault): runBootScan for pre-listen reconcile

Walks every markdown file under <vaultRoot>, calls reconcileFile
per path with signal=add, then archiveOrphans(diskPaths). Blocks
until consistent so HTTP listen sees an in-agreement vault."
```

---

## Task 13: Watcher wrapper — failing test

**Files:**

- Create: `tests/unit/backend/vault/watcher/watcher.test.ts`

- [ ] **Step 1: Write failing test using a chokidar EventEmitter mock**

```ts
// tests/unit/backend/vault/watcher/watcher.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVaultWatcher,
  type VaultWatcher,
} from "../../../../../src/backend/vault/watcher/watcher.js";
import { IgnoreSetImpl } from "../../../../../src/backend/vault/watcher/ignore-set.js";
import type { Reconciler } from "../../../../../src/backend/vault/watcher/reconciler.js";

// Mock chokidar by hijacking the import.
class MockFSWatcher extends EventEmitter {
  closeCalled = false;
  async close() {
    this.closeCalled = true;
  }
}

vi.mock("chokidar", () => {
  const watcher = new MockFSWatcher();
  return {
    default: { watch: vi.fn(() => watcher) },
    watch: vi.fn(() => watcher),
    __watcher: watcher,
  };
});

class StubReconciler implements Reconciler {
  calls: Array<{ absPath: string; signal: string }> = [];
  blockNext: Promise<void> | null = null;
  async reconcileFile(absPath: string, signal: "add" | "change" | "unlink") {
    this.calls.push({ absPath, signal });
    if (this.blockNext) await this.blockNext;
    return { action: "indexed" } as never;
  }
  async archiveOrphans() {
    return { archived: [] };
  }
}

async function getMockWatcher(): Promise<MockFSWatcher> {
  const mod = await import("chokidar");
  return (mod as unknown as { __watcher: MockFSWatcher }).__watcher;
}

describe("createVaultWatcher", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ab-watcher-"));
    await mkdir(join(root, "workspaces/ws/memories"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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
    await Promise.all([w.start(), Promise.resolve(mock.emit("ready"))]);

    const abs = join(root, "workspaces/ws/memories/a.md");
    await writeFile(abs, "x");
    mock.emit("change", abs);
    await new Promise((r) => setImmediate(r));

    expect(reconciler.calls).toEqual([{ absPath: abs, signal: "change" }]);
  });

  it("change event → reconciler skipped when ignoreSet has matching mtime", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    await Promise.all([w.start(), Promise.resolve(mock.emit("ready"))]);

    const abs = join(root, "workspaces/ws/memories/a.md");
    await writeFile(abs, "x");
    const s = await stat(abs);
    w.ignoreSet.add(abs, Number(s.mtime));

    mock.emit("change", abs);
    await new Promise((r) => setImmediate(r));

    expect(reconciler.calls).toHaveLength(0);
  });

  it("change event → reconciler called when ignoreSet has different mtime (R2)", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    await Promise.all([w.start(), Promise.resolve(mock.emit("ready"))]);

    const abs = join(root, "workspaces/ws/memories/a.md");
    await writeFile(abs, "x");
    // Record an mtime that won't match the file's actual mtime.
    w.ignoreSet.add(abs, 1);

    mock.emit("change", abs);
    await new Promise((r) => setImmediate(r));

    expect(reconciler.calls).toEqual([{ absPath: abs, signal: "change" }]);
  });

  it("'error' event is logged and does not throw", async () => {
    const reconciler = new StubReconciler();
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    await Promise.all([w.start(), Promise.resolve(mock.emit("ready"))]);
    expect(() => mock.emit("error", new Error("boom"))).not.toThrow();
  });

  it("stop() awaits in-flight reconciles", async () => {
    const reconciler = new StubReconciler();
    let resolveBlocked: () => void = () => {};
    reconciler.blockNext = new Promise<void>((r) => (resolveBlocked = r));
    const w = createVaultWatcher({ vaultRoot: root, reconciler });
    const mock = await getMockWatcher();
    await Promise.all([w.start(), Promise.resolve(mock.emit("ready"))]);

    const abs = join(root, "workspaces/ws/memories/a.md");
    await writeFile(abs, "x");
    mock.emit("change", abs);

    let stopped = false;
    const stopPromise = w.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false); // still waiting on the in-flight reconcile

    resolveBlocked();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(mock.closeCalled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/backend/vault/watcher/watcher.test.ts`
Expected: FAIL — `watcher.js` not found.

---

## Task 14: Watcher wrapper — implementation

**Files:**

- Create: `src/backend/vault/watcher/watcher.ts`

- [ ] **Step 1: Implement createVaultWatcher**

```ts
// src/backend/vault/watcher/watcher.ts
import chokidar from "chokidar";
import { stat } from "node:fs/promises";
import { logger } from "../../../utils/logger.js";
import { IgnoreSetImpl } from "./ignore-set.js";
import type { IgnoreSet, ReconcileSignal } from "./types.js";
import type { Reconciler } from "./reconciler.js";

export interface VaultWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly ignoreSet: IgnoreSet;
  // Sticky flag: set when chokidar emits 'error'. Surfaced in
  // BackendSessionStartMeta.watcher_error on next sessionStart.
  hadError(): boolean;
}

export interface CreateVaultWatcherOpts {
  vaultRoot: string;
  reconciler: Reconciler;
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number };
  graceMs?: number;
  // Allows tests / non-vault backends to inject a custom IgnoreSet
  // (e.g. NoopIgnoreSet). Defaults to a fresh IgnoreSetImpl.
  ignoreSet?: IgnoreSet;
}

export function createVaultWatcher(opts: CreateVaultWatcherOpts): VaultWatcher {
  const ignoreSet = opts.ignoreSet ?? new IgnoreSetImpl();
  const awaitWriteFinish = opts.awaitWriteFinish ?? {
    stabilityThreshold: 300,
    pollInterval: 100,
  };

  let watcher: chokidar.FSWatcher | null = null;
  let inFlight = 0;
  let drainResolvers: Array<() => void> = [];
  let hadError = false;

  const dispatch = async (
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<void> => {
    inFlight++;
    try {
      // Try to read mtime; if the file is gone (unlink already raced) we
      // still need to reconcile with whatever signal we got, but we use 0
      // as the comparison key — IgnoreSet.has() will return false (mtime
      // mismatch) so the reconcile proceeds.
      let currentMtime = 0;
      if (signal !== "unlink") {
        try {
          const s = await stat(absPath);
          currentMtime = Number(s.mtime);
        } catch {
          // best-effort
        }
      }
      if (ignoreSet.has(absPath, currentMtime)) return;
      try {
        await opts.reconciler.reconcileFile(absPath, signal);
      } catch (err) {
        logger.error(`watcher: reconcileFile threw for ${absPath}:`, err);
      }
    } finally {
      inFlight--;
      if (inFlight === 0 && drainResolvers.length > 0) {
        const r = drainResolvers;
        drainResolvers = [];
        for (const fn of r) fn();
      }
    }
  };

  return {
    ignoreSet,
    hadError: () => hadError,
    async start() {
      watcher = chokidar.watch(`${opts.vaultRoot}/**/*.md`, {
        ignoreInitial: true,
        awaitWriteFinish,
      });
      watcher.on("add", (p: string) => void dispatch(p, "add"));
      watcher.on("change", (p: string) => void dispatch(p, "change"));
      watcher.on("unlink", (p: string) => void dispatch(p, "unlink"));
      watcher.on("error", (err: unknown) => {
        hadError = true;
        logger.error("watcher: chokidar emitted error:", err);
      });
      await new Promise<void>((resolve) => {
        watcher!.on("ready", () => resolve());
      });
    },
    async stop() {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      if (inFlight === 0) return;
      await new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
      });
    },
  };
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `npx vitest run tests/unit/backend/vault/watcher/watcher.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 3: Run full suite**

Run: `npm run test:unit`
Expected: PASS — all unit tests green.

- [ ] **Step 4: Commit**

```bash
git add src/backend/vault/watcher/watcher.ts tests/unit/backend/vault/watcher/watcher.test.ts
git commit -m "feat(vault): chokidar watcher wrapper with mtime-tuple ignore

Subscribes to add/change/unlink with awaitWriteFinish 300/100 +
ignoreInitial:true. Each event consults IgnoreSet with current
mtime so internal writes skip but external edits colliding with
our window fall through. stop() awaits in-flight reconciles."
```

---

## Task 15: Plumb IgnoreSet through `VaultMemoryFiles.edit`

**Files:**

- Modify: `src/backend/vault/repositories/memory-files.ts`

Read the file first; the change must (a) accept an optional `IgnoreSet` ctor param defaulting to `NoopIgnoreSet`, (b) post-fsync inside `edit()` capture mtime + `add(absPath, mtime)`, (c) call `releaseAfter(absPath, 500)` after the write fully settles (commit + lance done — i.e. before `edit()` returns).

- [ ] **Step 1: Read current file**

Run: `cat src/backend/vault/repositories/memory-files.ts`
Note the constructor signature and the body of `edit()`.

- [ ] **Step 2: Add an `ignoreSet` ctor param + import**

At the top of the file:

```ts
import { stat } from "node:fs/promises";
import { NoopIgnoreSet } from "../watcher/ignore-set.js";
import type { IgnoreSet } from "../watcher/types.js";
```

Add to the constructor / options object the existing class uses:

```ts
  constructor(opts: {
    /* ...existing fields... */
    ignoreSet?: IgnoreSet;
    graceMs?: number;
  }) {
    /* ...existing assignments... */
    this.ignoreSet = opts.ignoreSet ?? new NoopIgnoreSet();
    this.graceMs = opts.graceMs ?? 500;
  }
```

- [ ] **Step 3: Wrap the markdown write in `edit()` with ignoreSet add/release**

Find the spot in `edit()` where the file has just been written + fsynced. Immediately after the write step, before the lock release / commit step, add:

```ts
// Tell the watcher this mtime came from our own write so it doesn't
// re-reconcile what we just emitted. mtime is the kernel-assigned
// timestamp; we capture it post-write so a chokidar event observing
// the same mtime is provably ours.
const s = await stat(absPath);
this.ignoreSet.add(absPath, Number(s.mtime));
```

Then, just before `edit()` returns to the caller (after the commit + lance write are done), schedule the release:

```ts
this.ignoreSet.releaseAfter(absPath, this.graceMs);
```

- [ ] **Step 4: Verify the existing tests still pass**

Run: `npm run test:unit -- memory-files`
Expected: PASS — current tests use the noop default, behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/repositories/memory-files.ts
git commit -m "feat(vault): wire IgnoreSet through VaultMemoryFiles.edit

Accept optional ignoreSet ctor param (defaults to NoopIgnoreSet so
existing tests + postgres path are untouched). On every edit:
record mtime post-write, schedule release after graceMs. Watcher
sees its own writes and skips."
```

---

## Task 16: Plumb IgnoreSet through `VaultMemoryRepository`

**Files:**

- Modify: `src/backend/vault/repositories/memory-repository.ts`
- Modify: any factory/builder that constructs `VaultMemoryRepository`

`VaultMemoryRepository.create(opts)` already exists. Add `ignoreSet?: IgnoreSet` to the opts and pass it through to the `VaultMemoryFiles` constructor; also use it on its own write paths (the markdown-writing helpers it calls directly for `create`/`update`/`archive`/`verify`).

- [ ] **Step 1: Read current `VaultMemoryRepository.create` signature**

Run: `grep -n "static create\|create(opts\|VaultMemoryFiles\|new Vault" src/backend/vault/repositories/memory-repository.ts | head`

Note where `VaultMemoryFiles` is instantiated (or where any direct fs writes happen).

- [ ] **Step 2: Thread ignoreSet through**

Add `ignoreSet?: IgnoreSet` to the create-opts type. Pass it forward to `VaultMemoryFiles`. For any direct write paths in this class (not going through `VaultMemoryFiles`), add the same `add(absPath, mtime)` + `releaseAfter(absPath, graceMs)` pattern from Task 15.

- [ ] **Step 3: Run repo tests**

Run: `npm run test:unit -- memory-repository`
Expected: PASS — defaults unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/backend/vault/repositories/memory-repository.ts
git commit -m "feat(vault): wire IgnoreSet through VaultMemoryRepository writes

Forwards ignoreSet to VaultMemoryFiles + records mtime/release on
any direct write paths (archive, etc.). Default is NoopIgnoreSet
so postgres + existing contract tests are untouched."
```

---

## Task 17: BackendSessionStartMeta — `watcher_error` field

**Files:**

- Modify: `src/backend/types.ts`

- [ ] **Step 1: Add the field**

```ts
  // Chokidar watcher emitted an 'error' event during this process's
  // lifetime. Sticky from first occurrence to process restart. Surfaces
  // here so clients can show a degraded-mode banner — watcher does NOT
  // auto-restart (silent-failure risk).
  watcher_error?: true;
```

Insert in `BackendSessionStartMeta` next to the other `?: true` flags (e.g. after `pull_conflict`).

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p .`
Expected: no errors. (Single-source-of-truth: envelope picks up the field via the existing `EnvelopeMeta = EnvelopeCoreMeta & BackendSessionStartMeta` intersection.)

- [ ] **Step 3: Commit**

```bash
git add src/backend/types.ts
git commit -m "feat(vault): BackendSessionStartMeta.watcher_error field

Sticky flag set when chokidar emits 'error'. Surfaces watcher
degradation to clients without auto-restart (silent-failure
risk). Envelope intersection picks it up automatically."
```

---

## Task 18: Wire boot scan + watcher into `VaultBackend.create()`

**Files:**

- Modify: `src/backend/vault/index.ts`

This is the largest single edit. The plan is:

1. Construct `IgnoreSetImpl` early in `create()`.
2. Pass it into `VaultMemoryRepository.create({ ..., ignoreSet })`.
3. Build a `Reconciler` from `vaultIndex` + `vectorIndex` + a `FlagService` instance + `embed`.
4. Run `runBootScan({ vaultRoot, reconciler })`. Surface `parseErrors`/`embedErrors` counts via `bootMeta` (zero values stripped per existing convention).
5. Construct + start a `VaultWatcher` with the same `ignoreSet`.
6. Store the watcher on the new `VaultBackend` instance.
7. `close()`: `watcher.stop()` BEFORE `pushQueue.close()`.
8. `sessionStart()`: surface `watcher_error: true` from `watcher.hadError()`.

`FlagService` needs an `AuditService` and a `projectId`. Read `src/backend/postgres/index.ts` to mirror how postgres builds these — same constructor pattern applies. (`AuditService` is small; `projectId` comes from config.)

- [ ] **Step 1: Read both backends to align on FlagService construction**

Run: `grep -n "new FlagService\|new AuditService\|projectId" src/backend/postgres/index.ts src/backend/vault/index.ts`

- [ ] **Step 2: Build reconciler dependencies**

Add inside `VaultBackend.create()`, after `memoryRepo` is created but before `return new VaultBackend(...)`:

```ts
    const ignoreSet = new IgnoreSetImpl();
    // Re-create memoryRepo with the ignoreSet — alternatively, plumb
    // ignoreSet into VaultMemoryRepository.create() directly above.
    // Pick whichever keeps the diff smallest after Task 16.

    const auditService = /* construct as the postgres backend does */;
    const flagService = new FlagService(
      flagRepoForVault,
      auditService,
      projectId,
    );

    const reconciler = createReconciler({
      vaultIndex: vaultIdx,
      vectorIndex,
      flagService,
      embed,
      vaultRoot: cfg.root,
    });

    const bootResult = await runBootScan({ vaultRoot: cfg.root, reconciler });
    if (bootResult.parseErrors > 0) {
      // Existing parse_errors meta is an array of {path, reason}; populate
      // it from vaultIdx.unindexable so the surface stays single-source.
      bootMeta.parse_errors = vaultIdx.unindexable.map((u) => ({
        path: u.path,
        reason: u.reason,
      }));
    }

    const watcher = createVaultWatcher({
      vaultRoot: cfg.root,
      reconciler,
      ignoreSet,
    });
    await watcher.start();
```

(Pseudocode. The exact placement / variable names depend on the post-Task 16 state of the file. Read carefully and integrate.)

- [ ] **Step 3: Store watcher on the instance**

Add `private readonly watcher: VaultWatcher` to the constructor + pass through:

```ts
return new VaultBackend(
  memoryRepo,
  vectorIndex,
  vaultIdx,
  cfg.root,
  gitOps,
  trackUsersInGit,
  git,
  pushQueue,
  embed,
  bootMeta,
  watcher,
);
```

- [ ] **Step 4: Update `close()` and `sessionStart()`**

```ts
  async close(): Promise<void> {
    await this.watcher.stop();
    await this.pushQueue.close();
    await this.vectorIndex.close();
  }
```

```ts
  async sessionStart(): Promise<BackendSessionStartMeta> {
    const meta = await runSessionStart({ /* ...existing... */ });
    if (this.bootMeta.remote_mismatch) meta.remote_mismatch = this.bootMeta.remote_mismatch;
    if (this.bootMeta.reconcile_failed) meta.reconcile_failed = true;
    if (this.bootMeta.parse_errors && this.bootMeta.parse_errors.length > 0) {
      meta.parse_errors = this.bootMeta.parse_errors;
    }
    if (this.watcher.hadError()) meta.watcher_error = true;
    return meta;
  }
```

- [ ] **Step 5: Run the full test suite**

Run: `npm run test:unit`
Expected: PASS.

Run: `npm test` (if integration tests are wired — check `package.json scripts`)
Expected: PASS or only failures in tests known unrelated to this PR.

- [ ] **Step 6: Commit**

```bash
git add src/backend/vault/index.ts
git commit -m "feat(vault): wire boot scan + watcher into VaultBackend.create

Boot scan blocks until the vault is internally consistent (lance ↔
vaultIndex). Watcher then starts with chokidar + ignoreInitial:
true. close() awaits watcher.stop() before pushQueue. session-
Start surfaces watcher_error sticky flag."
```

---

## Task 19: E2E smoke test — external add/edit/rm

**Files:**

- Create: `tests/integration/vault-watcher-e2e.test.ts`

Five cases per spec D7 / Section "Testing T4". Real chokidar, real `VaultBackend`, tmpdir vault. PR-only with `--testTimeout=10000`. Use polling helpers (`until`) rather than fixed sleeps where possible.

- [ ] **Step 1: Write the E2E test file**

```ts
// tests/integration/vault-watcher-e2e.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBackend } from "../../src/backend/vault/index.js";

async function until<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 8000,
  intervalMs = 100,
): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`until(): timed out after ${timeoutMs}ms`);
}

describe("vault watcher E2E", { timeout: 10_000 }, () => {
  let root: string;
  let backend: VaultBackend;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ab-watcher-e2e-"));
    backend = await VaultBackend.create({
      root,
      embeddingDimensions: 4,
      embed: async (text: string) => {
        const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
        return [
          seed % 100,
          (seed * 7) % 100,
          (seed * 13) % 100,
          (seed * 17) % 100,
        ];
      },
    });
  });

  afterEach(async () => {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });

  function makeMd(id: string, body = "External body.") {
    return `---
id: ${id}
title: ${id}
type: pattern
scope: workspace
workspace_id: ws
project_id: proj
author: alice
source: agent-auto
created_at: "2026-04-25T00:00:00.000Z"
updated_at: "2026-04-25T00:00:00.000Z"
embedding_model: stub
embedding_dims: 4
---

# ${id}

${body}

## Relationships

## Comments
`;
  }

  it("external add → memory becomes searchable", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ext-add.md"), makeMd("ext-add"));

    const found = await until(async () => {
      const m = await backend.memoryRepo.findById("ext-add");
      return m ? true : undefined;
    });
    expect(found).toBe(true);
  });

  it("external edit of body → memory re-embedded", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "ext-edit.md");
    await writeFile(path, makeMd("ext-edit", "First version of the body."));

    await until(async () =>
      (await backend.memoryRepo.findById("ext-edit")) ? true : undefined,
    );

    // External edit: change the body so a re-embed must fire.
    await writeFile(
      path,
      makeMd("ext-edit", "Completely different second version."),
    );

    // The lance row's content_hash should now reflect the new body. Use
    // search to verify: the new body's distinctive token should rank
    // higher than the old one.
    const ok = await until(async () => {
      const results = await backend.memoryRepo.search(
        { query: "completely different second version", limit: 5 },
        { dims: 4 },
      );
      return results.find((r) => r.id === "ext-edit") ? true : undefined;
    });
    expect(ok).toBe(true);
  });

  it("external rm → memory excluded from search", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "ext-rm.md");
    await writeFile(path, makeMd("ext-rm"));

    await until(async () =>
      (await backend.memoryRepo.findById("ext-rm")) ? true : undefined,
    );

    await rm(path);

    const gone = await until(async () => {
      const m = await backend.memoryRepo.findById("ext-rm");
      return m === null || m === undefined ? true : undefined;
    });
    expect(gone).toBe(true);
  });

  it("internal create does NOT trigger a duplicate reindex", async () => {
    // Internal write goes through memory_create / VaultMemoryRepository.
    // The IgnoreSet entry recorded post-fsync should make the chokidar
    // change event a no-op. We assert this by stubbing the embedder to
    // count calls — exactly one call, not two.
    let embedCalls = 0;
    const countingBackend = await VaultBackend.create({
      root: await mkdtemp(join(tmpdir(), "ab-watcher-internal-")),
      embeddingDimensions: 4,
      embed: async (text: string) => {
        embedCalls++;
        const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
        return [
          seed % 100,
          (seed * 7) % 100,
          (seed * 13) % 100,
          (seed * 17) % 100,
        ];
      },
    });
    try {
      await countingBackend.memoryRepo.create({
        id: "int-create",
        title: "Internal create",
        content: "Internal body content for IgnoreSet test.",
        type: "pattern",
        scope: "workspace",
        workspaceId: "ws",
        userId: null,
        projectId: "proj",
        author: "alice",
        source: "agent-auto",
        tags: [],
      } as never);

      const t0 = Date.now();
      // Wait long enough for chokidar awaitWriteFinish (300ms) + grace.
      while (Date.now() - t0 < 1000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(embedCalls).toBe(1);
    } finally {
      await countingBackend.close();
    }
  });

  it("boot scan repairs state after a kill mid-edit", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "boot-test.md");
    await writeFile(path, makeMd("boot-test"));

    await until(async () =>
      (await backend.memoryRepo.findById("boot-test")) ? true : undefined,
    );

    // Simulate "kill" by closing the backend without giving the watcher a
    // chance to handle a subsequent external edit. Then write the edit,
    // then re-open the backend — boot scan should reconcile.
    await backend.close();

    await writeFile(path, makeMd("boot-test", "Body changed while down."));

    backend = await VaultBackend.create({
      root,
      embeddingDimensions: 4,
      embed: async (text: string) => {
        const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
        return [
          seed % 100,
          (seed * 7) % 100,
          (seed * 13) % 100,
          (seed * 17) % 100,
        ];
      },
    });

    const ok = await until(async () => {
      const results = await backend.memoryRepo.search(
        { query: "body changed while down", limit: 5 },
        { dims: 4 },
      );
      return results.find((r) => r.id === "boot-test") ? true : undefined;
    });
    expect(ok).toBe(true);
  });
});
```

(Note on `memoryRepo.search` signature: the call shape above assumes `search(input, opts?)`. If the actual `MemoryRepository.search` signature differs, adapt the test to match — the goal is "memory is findable via vector search after the external edit".)

- [ ] **Step 2: Run the E2E suite**

Run: `npx vitest run tests/integration/vault-watcher-e2e.test.ts`
Expected: 5 tests PASS within 10s timeout each.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/vault-watcher-e2e.test.ts
git commit -m "test(vault): Phase 5 E2E smoke for chokidar watcher

Real chokidar + real VaultBackend + tmpdir. Five cases:
external add becomes searchable, external edit re-embeds,
external rm archives, internal write doesn't double-reindex,
boot-scan converges after kill mid-edit. PR-only via the
testTimeout: 10_000 option."
```

---

## Task 20: Update predecessor non-vault factories

**Files:**

- Modify: `tests/contract/repositories/_factories.ts` (and any other vault-repo construction site if Task 16 changed signatures)

Goal: any place that constructs `VaultMemoryRepository` or `VaultMemoryFiles` must pass either no `ignoreSet` (defaulting to noop) or `new NoopIgnoreSet()`. Verify nothing breaks.

- [ ] **Step 1: Search for construction sites**

Run: `grep -rn "VaultMemoryRepository.create\|new VaultMemoryFiles" src tests`

- [ ] **Step 2: Update each call site if needed**

Default-arg path means most won't need changes. Only update if the test passes a strict opts object that fails type-check after Task 16.

- [ ] **Step 3: Run the full test suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 4: Commit (if any test files changed)**

```bash
git add tests/
git commit -m "test(vault): pass NoopIgnoreSet through repo factories"
```

(Skip if nothing changed.)

---

## Task 21: Verification & roadmap update

**Files:**

- Modify: `docs/superpowers/specs/2026-04-21-vault-backend-design.md` — flip Phase 5 row to "Done"

- [ ] **Step 1: Run the full suite + typecheck + lint**

Run: `npm run test:unit && npx tsc --noEmit && npx eslint . --max-warnings=0`
Expected: all green.

- [ ] **Step 2: Run integration suite if available**

Run: `SKIP_DOCKER_START=1 npm test` (if running in a worktree with the parent docker stack already up — see memory `KV9Pu5pA3AFae-Wg-mpbK`).
Expected: all integration tests pass; if any failure, diagnose before merging.

- [ ] **Step 3: Update the roadmap row**

Edit `docs/superpowers/specs/2026-04-21-vault-backend-design.md`. Find the row:

```
| 5     | Chokidar watcher. External edit E2E.                                                                                                   |
```

Replace with:

```
| 5     | Chokidar watcher + boot reconcile + parse_error live producer + lance↔markdown drift repair. **Done — #TBD.** |
```

(Replace `#TBD` with the real PR number once the PR is opened.)

- [ ] **Step 4: Commit roadmap update**

```bash
git add docs/superpowers/specs/2026-04-21-vault-backend-design.md
git commit -m "docs(vault): mark roadmap Phase 5 done

Watcher + boot reconcile + parse_error live producer shipped.
PR number filled in once the PR is opened."
```

---

## Self-review notes

**Spec coverage check:** Goals 1-4 → Tasks 5-12 (reconciler) + 11-12 (boot scan) + 13-14 (watcher); D2 ignoreSet → Tasks 3-4 + 15-16; D4 event handling → Tasks 5-10; D5 boot reconcile gating → Task 18; D7 testing tiers T1/T2/T3/T4 → Tasks 5-12 / 13-14 / 11-12 / 19. `watcher_error` meta (E4) → Task 17 + Task 18 step 4. PR #37 deferred gap closure (Goal 3) → Task 8 (unlink event handles git-pull deletes). All spec sections accounted for.

**Type consistency check:** `Reconciler` interface defined in Task 6 (`reconcileFile`, `archiveOrphans`); used identically in Tasks 11-14. `IgnoreSet` defined Task 2; same shape used Tasks 3-4, 13-14, 15-16. `BootScanResult` defined Task 2; produced Task 12; consumed Task 18.

**Placeholder scan:** No `TBD` / `TODO` / "fill in details" — Task 19's "stubbed" cases are explicit (named, shape shown). Task 21 has `#TBD` for the PR number, which is unavoidable until the PR is opened.

**Risks / known limits:**

- Task 18 has the most integration friction. If post-Task 16 file diff is large, split into 18a (boot scan only) + 18b (watcher start + close + sessionStart).
- Reconciler test stubs in Task 5 cast to `as never` for vector-index ops. If the real `VaultVectorIndex` API differs (e.g. `softArchive` doesn't exist as a separate method, only `update {archived:true}`), adapt the stub — adjust the production reconciler to match.
- E2E test in Task 19 needs polling intervals that are short enough to keep test runtime tight (~1-2s per case). Real chokidar `awaitWriteFinish: 300` plus mtime stat means the absolute floor is ~400ms per state transition. Five cases × ~1s each + setup/teardown should fit in <10s comfortably.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-25-vault-backend-phase-5-watcher.md`.**
