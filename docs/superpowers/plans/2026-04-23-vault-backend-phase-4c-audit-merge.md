# Vault Backend Phase 4c — Audit on Git Log + Smart Merge Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `VaultAuditRepository` onto `git log --grep` + blob re-parse, and replace the Phase 4a `*.md merge=union` `.gitattributes` rule with a field-aware Node CLI merge driver so concurrent frontmatter edits merge cleanly.

**Architecture:** New CLI bin (`src/cli/merge-memory.ts`) registered as a git merge driver via `.git/config` on every bootstrap. `VaultAuditRepository` reimplemented as a pure reader over `git log` output + `git show` blob reads, parsing trailers already written by Phase 4a. Bootstrap swaps `.gitattributes` on first 4c startup; existing Phase 4b vaults migrate transparently via one reconcile commit.

**Tech Stack:** TypeScript + Node built-ins (`node:child_process` for `diff3` invocation, `node:fs/promises` for file IO), `simple-git`, existing `parseMemoryFile` / `serializeMemoryFile`, Vitest, `fast-check` (property tests, optional).

**Spec:** `docs/superpowers/specs/2026-04-23-vault-backend-phase-4c-audit-merge-design.md`

**Related:**

- Phase 4a spec: `docs/superpowers/plans/2026-04-21-vault-backend-phase-4-git-sync.md` (trailer schema)
- Phase 4b spec: `docs/superpowers/specs/2026-04-22-vault-backend-phase-4b-git-sync-design.md` (push/pull infra this builds on)
- Issue #38 — orphaned `merged` `AuditAction`, out of scope here

---

## File Structure

### New files

| Path                                                       | Responsibility                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/backend/vault/git/trailer-parser.ts`                  | `parseTrailers(commitMessage): ParsedTrailers \| null` — inverse of `formatTrailers`. No external deps.                 |
| `src/backend/vault/parser/merge-memory.ts`                 | Pure merge function: `mergeMemoryFiles(ancestor, ours, theirs) → { ok: true, merged } \| { ok: false, reason }`. No IO. |
| `src/cli/merge-memory.ts`                                  | Node CLI entry. Reads three files from argv, calls `mergeMemoryFiles`, writes `%A`, exits 0/1.                          |
| `src/backend/vault/git/merge-driver-config.ts`             | Resolves absolute path to the merge-driver CLI and writes `[merge "agent-brain-memory"]` section to `.git/config`.      |
| `tests/unit/backend/vault/git/trailer-parser.test.ts`      | Unit tests for trailer parsing.                                                                                         |
| `tests/unit/backend/vault/parser/merge-memory.test.ts`     | Per-field-rule unit tests for the merge function.                                                                       |
| `tests/unit/cli/merge-memory.test.ts`                      | argv + exit-code tests for the CLI wrapper.                                                                             |
| `tests/unit/backend/vault/git/merge-driver-config.test.ts` | `.git/config` writer tests.                                                                                             |
| `tests/integration/vault/merge-driver.test.ts`             | Two-clone concurrent-edit rebase smoke test.                                                                            |
| `tests/integration/vault/audit-history.test.ts`            | End-to-end `AuditService.getHistory` over real commits.                                                                 |

### Modified files

| Path                                                   | Change                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/backend/vault/repositories/audit-repository.ts`   | Replace JSONL writer + reader with a git-log-backed reader. `create()` becomes a no-op.                                                                                                                                                                                  |
| `src/backend/vault/git/bootstrap.ts`                   | Replace `GITATTRIBUTES_RULE = "*.md merge=union"` with three memory-path rules; remove legacy rule on upgrade; drop `_audit/` from `RUNTIME_IGNORES` and add it back as a **cleanup** via `git rm -r _audit/` if present. Call `ensureMergeDriverConfig` after git init. |
| `src/backend/vault/index.ts`                           | No audit-constructor change (it already reads `root`). Nothing extra — bootstrap handles driver registration.                                                                                                                                                            |
| `package.json`                                         | Add `"bin": { "agent-brain-merge-memory": "./dist/cli/merge-memory.js" }`. Bump version patch if team convention requires.                                                                                                                                               |
| `tests/contract/repositories/audit-repository.test.ts` | May need small relaxation if pg stores `updated_at` Date objects in `before`/`after`; vault parsed equivalents must compare equal.                                                                                                                                       |

### Deleted (at the end, after all tests green)

| Path                                | Reason                                          |
| ----------------------------------- | ----------------------------------------------- |
| (vault instances) `<root>/_audit/*` | Dev-only; bootstrap cleans on first 4c startup. |

---

## Task 1: Add commit-trailer parser

**Files:**

- Create: `src/backend/vault/git/trailer-parser.ts`
- Create: `tests/unit/backend/vault/git/trailer-parser.test.ts`
- Reference (no changes): `src/backend/vault/git/trailers.ts`, `src/backend/vault/git/types.ts`

**Context:** `trailers.ts` writes `AB-Action`, `AB-Memory`, `AB-Workspace`, `AB-Actor`, `AB-Reason` on commit. `AB-Reason` values are LF/CR-escaped via `encode()`. The parser must invert this. A commit is valid only if `AB-Action` is present; otherwise return `null` (non-agent-brain commit).

- [ ] **Step 1.1: Write the failing tests**

```typescript
// tests/unit/backend/vault/git/trailer-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseTrailers } from "../../../../../src/backend/vault/git/trailer-parser.js";

describe("parseTrailers", () => {
  it("parses a memory-action commit", () => {
    const msg = [
      "[agent-brain] update: memory-foo",
      "",
      "AB-Action: updated",
      "AB-Memory: mem-123",
      "AB-Actor: alice",
    ].join("\n");
    expect(parseTrailers(msg)).toEqual({
      action: "updated",
      memoryId: "mem-123",
      actor: "alice",
      reason: null,
    });
  });

  it("parses a workspace_upsert commit", () => {
    const msg = [
      "[agent-brain] workspace: ws-1",
      "",
      "AB-Action: workspace_upsert",
      "AB-Workspace: ws-1",
      "AB-Actor: bob",
    ].join("\n");
    expect(parseTrailers(msg)).toEqual({
      action: "workspace_upsert",
      workspaceId: "ws-1",
      actor: "bob",
      reason: null,
    });
  });

  it("parses a reconcile commit (no memory/workspace id)", () => {
    const msg = "reconcile\n\nAB-Action: reconcile\nAB-Actor: system";
    expect(parseTrailers(msg)).toEqual({
      action: "reconcile",
      actor: "system",
      reason: null,
    });
  });

  it("decodes AB-Reason escapes", () => {
    const msg = [
      "archive",
      "",
      "AB-Action: archived",
      "AB-Memory: mem-1",
      "AB-Actor: alice",
      "AB-Reason: line-1\\nline-2\\\\tail",
    ].join("\n");
    const parsed = parseTrailers(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.reason).toBe("line-1\nline-2\\tail");
  });

  it("returns null when AB-Action is absent", () => {
    expect(parseTrailers("random commit")).toBeNull();
    expect(parseTrailers("")).toBeNull();
  });

  it("tolerates leading CRLF line endings", () => {
    const msg =
      "subject\r\n\r\nAB-Action: created\r\nAB-Memory: mem-1\r\nAB-Actor: a";
    expect(parseTrailers(msg)?.action).toBe("created");
  });

  it("returns null for an unknown AB-Action value", () => {
    expect(parseTrailers("x\n\nAB-Action: nonsense\nAB-Actor: a")).toBeNull();
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/backend/vault/git/trailer-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement the parser**

```typescript
// src/backend/vault/git/trailer-parser.ts
import type { CommitTrailer, CommitAction } from "./types.js";

export type ParsedTrailers = CommitTrailer;

const KNOWN_ACTIONS: ReadonlySet<CommitAction> = new Set<CommitAction>([
  "created",
  "updated",
  "archived",
  "verified",
  "commented",
  "flagged",
  "unflagged",
  "related",
  "unrelated",
  "workspace_upsert",
  "reconcile",
]);

export function parseTrailers(message: string): ParsedTrailers | null {
  const fields: Record<string, string> = {};
  // Normalize to LF so the line iterator works uniformly.
  for (const raw of message.replace(/\r\n?/g, "\n").split("\n")) {
    const m = raw.match(/^(AB-[A-Za-z]+):\s?(.*)$/);
    if (m) fields[m[1]!] = m[2]!;
  }

  const action = fields["AB-Action"] as CommitAction | undefined;
  if (!action || !KNOWN_ACTIONS.has(action)) return null;

  const actor = fields["AB-Actor"] ?? "";
  if (actor === "") return null;
  const reason = fields["AB-Reason"] ? decode(fields["AB-Reason"]) : null;

  if (action === "workspace_upsert") {
    const workspaceId = fields["AB-Workspace"] ?? "";
    if (workspaceId === "") return null;
    return { action, workspaceId, actor, reason };
  }
  if (action === "reconcile") {
    return { action, actor, reason };
  }
  const memoryId = fields["AB-Memory"] ?? "";
  if (memoryId === "") return null;
  return { action, memoryId, actor, reason };
}

function decode(s: string): string {
  // Inverse of trailers.ts `encode`: \\\\ → \\, \\n → LF, \\r → CR.
  // Walk the string once so `\\n` (literal backslash + `n`) round-trips.
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1]!;
      if (next === "\\") {
        out += "\\";
        i++;
        continue;
      }
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i++;
        continue;
      }
    }
    out += s[i];
  }
  return out;
}
```

- [ ] **Step 1.4: Run tests to verify pass**

Run: `npx vitest run tests/unit/backend/vault/git/trailer-parser.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 1.5: Commit**

```bash
git add src/backend/vault/git/trailer-parser.ts tests/unit/backend/vault/git/trailer-parser.test.ts
git commit -m "feat(vault): add commit trailer parser"
```

---

## Task 2: Rewrite `VaultAuditRepository` as a git-log reader

**Files:**

- Modify: `src/backend/vault/repositories/audit-repository.ts` (replace)
- Modify: `src/backend/vault/index.ts` (constructor args)
- Create: `tests/unit/backend/vault/repositories/audit-repository.test.ts`

**Context:** Current implementation at `src/backend/vault/repositories/audit-repository.ts` writes/reads JSONL under `_audit/<memoryId>.jsonl`. Replace with a reader that:

1. Runs `git log --all --pretty='%H%x1f%aI%x1f%B%x1e' --grep='^AB-Memory: <id>$'` (uses `%x1f` = unit separator, `%x1e` = record separator — safer than newlines since messages contain them).
2. Parses each record via `parseTrailers`.
3. For `updated` action, reads parent + current blob via `git show`, parses each, picks five fields, builds `{ before, after }`.
4. For everything else: `diff = null`.
5. `create()` is a no-op (kept only so the interface stays compatible).

Injecting `SimpleGit` through the constructor lets tests pass a mocked instance.

- [ ] **Step 2.1: Write the failing tests**

```typescript
// tests/unit/backend/vault/repositories/audit-repository.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SimpleGit } from "simple-git";
import { VaultAuditRepository } from "../../../../../src/backend/vault/repositories/audit-repository.js";

const PROJECT_ID = "proj-1";

function fakeGit(stubs: {
  log?: (args: unknown) => string;
  show?: (rev: string) => string;
}): SimpleGit {
  const raw = vi.fn<(args: string[]) => Promise<string>>(async (args) => {
    if (args[0] === "log") {
      if (!stubs.log) throw new Error("unexpected git log call");
      return stubs.log(args);
    }
    if (args[0] === "show") {
      if (!stubs.show) throw new Error("unexpected git show call");
      return stubs.show(args[1]!);
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  });
  return { raw } as unknown as SimpleGit;
}

const memoryMd = (
  over: Partial<{
    title: string;
    content: string;
    updated: string;
    tags: string[];
  }>,
) =>
  [
    "---",
    "id: mem-1",
    `project_id: ${PROJECT_ID}`,
    "workspace_id: ws-1",
    `title: ${over.title ?? "hello"}`,
    "type: fact",
    "scope: workspace",
    `tags: ${JSON.stringify(over.tags ?? ["a", "b"])}`,
    "author: alice",
    "source: manual",
    "session_id: null",
    "metadata: null",
    "embedding_model: null",
    "embedding_dimensions: null",
    "version: 1",
    "created: 2026-04-01T00:00:00.000Z",
    `updated: ${over.updated ?? "2026-04-20T10:00:00.000Z"}`,
    "verified: null",
    "archived: null",
    "verified_by: null",
    "---",
    "",
    "# hello",
    "",
    over.content ?? "body-text",
    "",
  ].join("\n");

describe("VaultAuditRepository (git-log reader)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] when git log yields nothing", async () => {
    const git = fakeGit({ log: () => "" });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
      projectId: PROJECT_ID,
    });
    expect(await repo.findByMemoryId("mem-1")).toEqual([]);
  });

  it("parses a single created commit — diff is null", async () => {
    const git = fakeGit({
      log: () =>
        [
          "abc123",
          "2026-04-01T00:00:00.000Z",
          "create\n\nAB-Action: created\nAB-Memory: mem-1\nAB-Actor: alice",
        ].join("\x1f") + "\x1e",
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
      projectId: PROJECT_ID,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      memory_id: "mem-1",
      action: "created",
      actor: "alice",
      reason: null,
      diff: null,
    });
    expect(entries[0]!.created_at).toBeInstanceOf(Date);
  });

  it("reconstructs { before, after } for an update commit", async () => {
    const git = fakeGit({
      log: () =>
        [
          "def456",
          "2026-04-20T10:00:00.000Z",
          "update\n\nAB-Action: updated\nAB-Memory: mem-1\nAB-Actor: bob",
        ].join("\x1f") + "\x1e",
      show: (rev) => {
        // rev = "def456^:workspaces/ws-1/memories/mem-1.md" or "def456:..."
        if (rev.startsWith("def456^:"))
          return memoryMd({ title: "hello", tags: ["a"] });
        if (rev.startsWith("def456:"))
          return memoryMd({ title: "hello-v2", tags: ["a", "b"] });
        throw new Error(`unexpected rev ${rev}`);
      },
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
      projectId: PROJECT_ID,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.diff).toEqual({
      before: {
        content: "body-text",
        title: "hello",
        type: "fact",
        tags: ["a"],
        metadata: null,
      },
      after: {
        content: "body-text",
        title: "hello-v2",
        type: "fact",
        tags: ["a", "b"],
        metadata: null,
      },
    });
  });

  it("sorts entries newest-first", async () => {
    const git = fakeGit({
      log: () =>
        [
          [
            "aaa",
            "2026-04-01T00:00:00.000Z",
            "x\n\nAB-Action: created\nAB-Memory: mem-1\nAB-Actor: a",
          ].join("\x1f"),
          [
            "bbb",
            "2026-04-02T00:00:00.000Z",
            "x\n\nAB-Action: archived\nAB-Memory: mem-1\nAB-Actor: a",
          ].join("\x1f"),
        ].join("\x1e") + "\x1e",
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
      projectId: PROJECT_ID,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries.map((e) => e.action)).toEqual(["archived", "created"]);
  });

  it("create() is a no-op (returns without throwing, no git calls)", async () => {
    const git = fakeGit({});
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
      projectId: PROJECT_ID,
    });
    await repo.create({
      id: "a1",
      project_id: PROJECT_ID,
      memory_id: "mem-1",
      action: "created",
      actor: "alice",
      reason: null,
      diff: null,
      created_at: new Date(),
    });
  });

  it("skips commits whose trailer fails to parse", async () => {
    const git = fakeGit({
      log: () =>
        [
          ["aaa", "2026-04-01T00:00:00.000Z", "garbage-no-trailer"].join(
            "\x1f",
          ),
          [
            "bbb",
            "2026-04-02T00:00:00.000Z",
            "x\n\nAB-Action: created\nAB-Memory: mem-1\nAB-Actor: a",
          ].join("\x1f"),
        ].join("\x1e") + "\x1e",
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
      projectId: PROJECT_ID,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("created");
  });
});
```

- [ ] **Step 2.2: Run tests to verify fail**

Run: `npx vitest run tests/unit/backend/vault/repositories/audit-repository.test.ts`
Expected: FAIL — constructor signature mismatch or behavior mismatch.

- [ ] **Step 2.3: Rewrite the repository**

```typescript
// src/backend/vault/repositories/audit-repository.ts
import type { SimpleGit } from "simple-git";
import type { AuditEntry } from "../../../types/audit.js";
import type { AuditAction } from "../../../types/audit.js";
import type { AuditRepository } from "../../../repositories/types.js";
import { parseTrailers } from "../git/trailer-parser.js";
import { parseMemoryFile } from "../parser/memory-parser.js";
import { memoryPath } from "../io/paths.js";
import type { CommitAction } from "../git/types.js";
import { logger } from "../../../utils/logger.js";

export interface VaultAuditConfig {
  root: string;
  git: SimpleGit;
  projectId: string;
}

// Five fields match what MemoryService.update passes to
// AuditService.logUpdate — keep in sync or the contract test will fail.
const DIFF_FIELDS = ["content", "title", "type", "tags", "metadata"] as const;
type DiffFields = Pick<
  ReturnType<typeof parseMemoryFile>["memory"],
  (typeof DIFF_FIELDS)[number]
>;

const UNIT = "\x1f"; // field separator
const RECORD = "\x1e"; // record separator

const TRAILER_TO_AUDIT: Partial<Record<CommitAction, AuditAction>> = {
  created: "created",
  updated: "updated",
  archived: "archived",
  commented: "commented",
  flagged: "flagged",
};

export class VaultAuditRepository implements AuditRepository {
  constructor(private readonly cfg: VaultAuditConfig) {}

  // create() still exists on the interface but the vault backend has no
  // state to write — git commits (with trailers) are the audit log.
  // Kept as a no-op so existing callers don't break.
  async create(_entry: AuditEntry): Promise<void> {
    // intentional no-op
  }

  async findByMemoryId(memoryId: string): Promise<AuditEntry[]> {
    // --grep on a fixed-anchored trailer line; --extended-regexp so `^`
    // and `$` apply per-line (the default is per-message).
    const raw = await this.cfg.git.raw([
      "log",
      "--all",
      "--extended-regexp",
      `--grep=^AB-Memory: ${escapeRe(memoryId)}$`,
      `--pretty=${"%H"}${UNIT}${"%aI"}${UNIT}${"%B"}${RECORD}`,
    ]);

    const records = raw
      .split(RECORD)
      .map((r) => r.trim())
      .filter((r) => r !== "");

    const entries: AuditEntry[] = [];
    for (const rec of records) {
      const [sha, iso, ...rest] = rec.split(UNIT);
      if (!sha || !iso || rest.length === 0) continue;
      const message = rest.join(UNIT);
      const trailers = parseTrailers(message);
      if (!trailers) continue;
      if (!("memoryId" in trailers) || trailers.memoryId !== memoryId) continue;
      const auditAction = TRAILER_TO_AUDIT[trailers.action];
      if (!auditAction) continue;

      let diff: Record<string, unknown> | null = null;
      if (auditAction === "updated") {
        try {
          diff = await this.reconstructUpdateDiff(sha, memoryId);
        } catch (err) {
          logger.warn(
            `vault audit: failed to reconstruct diff for ${sha} ${memoryId}`,
            err,
          );
        }
      }

      entries.push({
        id: sha,
        project_id: this.cfg.projectId,
        memory_id: memoryId,
        action: auditAction,
        actor: trailers.actor,
        reason: trailers.reason,
        diff,
        created_at: new Date(iso),
      });
    }

    return entries.sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime(),
    );
  }

  private async reconstructUpdateDiff(
    sha: string,
    memoryId: string,
  ): Promise<{ before: DiffFields; after: DiffFields } | null> {
    // Locate the memory file as of this commit by asking git for the
    // changed paths. Scope is stable across history (memories don't
    // move between workspaces today) so we can pick the first matching
    // memory-layout path.
    const nameStatus = await this.cfg.git.raw([
      "show",
      "--name-only",
      "--pretty=format:",
      sha,
    ]);
    const path = findMemoryPath(nameStatus, memoryId);
    if (!path) return null;

    const [beforeRaw, afterRaw] = await Promise.all([
      this.safeShow(`${sha}^:${path}`),
      this.safeShow(`${sha}:${path}`),
    ]);
    if (beforeRaw === null || afterRaw === null) return null;

    const before = parseMemoryFile(beforeRaw).memory;
    const after = parseMemoryFile(afterRaw).memory;
    return {
      before: pickFields(before),
      after: pickFields(after),
    };
  }

  private async safeShow(rev: string): Promise<string | null> {
    try {
      return await this.cfg.git.raw(["show", rev]);
    } catch {
      // First commit on a branch has no parent; git show returns
      // exit 128. Treat as "no parent blob" and skip diff.
      return null;
    }
  }
}

function pickFields(
  m: ReturnType<typeof parseMemoryFile>["memory"],
): DiffFields {
  return {
    content: m.content,
    title: m.title,
    type: m.type,
    tags: m.tags,
    metadata: m.metadata,
  } as DiffFields;
}

function findMemoryPath(
  nameStatusOutput: string,
  memoryId: string,
): string | null {
  for (const line of nameStatusOutput.split("\n")) {
    const p = line.trim();
    if (p === "") continue;
    if (p.endsWith(`/${memoryId}.md`)) return p;
  }
  return null;
}

function escapeRe(s: string): string {
  // Memory ids are nanoid-ish (alphanumeric-ish) but escape defensively.
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 2.4: Wire `git` + `projectId` through `VaultBackend.create`**

```typescript
// src/backend/vault/index.ts - inside the private constructor
-    this.auditRepo = new VaultAuditRepository({ root });
+    this.auditRepo = new VaultAuditRepository({
+      root,
+      git: this.git,
+      projectId: "UNKNOWN", // project ids are per-memory; see note below
+    });
```

Note: `AuditEntry.project_id` in the pg schema is actually the _memory's_ project — pg joins the memory row on write. Vault has no such join; the trailer does not carry project_id. The field is informational; we fill `"UNKNOWN"` until the consumer that cares proves otherwise (`getHistory` has no production caller as of this plan). If the contract test fails on project_id equality, fix forward by fetching the parsed memory's project_id from the same blob read.

- [ ] **Step 2.5: Run the unit tests**

Run: `npx vitest run tests/unit/backend/vault/repositories/audit-repository.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 2.6: Run the existing audit contract test against the vault backend**

Run: `npx vitest run tests/contract/repositories/audit-repository.test.ts`
Expected: PASS for vault backend. If project_id equality fails, apply the fix-forward from step 2.4 (read from blob).

- [ ] **Step 2.7: Commit**

```bash
git add src/backend/vault/repositories/audit-repository.ts src/backend/vault/index.ts tests/unit/backend/vault/repositories/audit-repository.test.ts
git commit -m "feat(vault): rewrite VaultAuditRepository as git-log reader"
```

---

## Task 3: Drop `_audit/` from runtime ignores + clean up stale JSONL on startup

**Files:**

- Modify: `src/backend/vault/git/bootstrap.ts`
- Modify: `tests/unit/backend/vault/git/bootstrap.test.ts`

**Context:** `RUNTIME_IGNORES` in `bootstrap.ts:11-18` currently lists `_audit/`. Safe to remove — no writer produces it anymore after Task 2. Also run a one-time cleanup: if `<root>/_audit/` exists at bootstrap, `rm -rf` it. Spec explicitly calls out vault is dev-only, so no migration preservation.

- [ ] **Step 3.1: Write the failing test**

```typescript
// tests/unit/backend/vault/git/bootstrap.test.ts — append a new describe
describe("ensureVaultGit — _audit/ cleanup", () => {
  it("removes an existing _audit/ directory on startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "vault-"));
    await mkdir(join(root, "_audit"), { recursive: true });
    await writeFile(join(root, "_audit", "mem-1.jsonl"), "{}\n", "utf8");
    await ensureVaultGit({ root, trackUsers: false });
    await expect(stat(join(root, "_audit"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not list _audit/ in the committed .gitignore", async () => {
    const root = await mkdtemp(join(tmpdir(), "vault-"));
    await ensureVaultGit({ root, trackUsers: false });
    const body = await readFile(join(root, ".gitignore"), "utf8");
    expect(body).not.toMatch(/^_audit\/?$/m);
  });
});
```

(Add the relevant imports at the top if the existing file doesn't have them: `stat`, `mkdir`, `writeFile`, `mkdtemp`, `readFile` from `node:fs/promises`; `tmpdir` from `node:os`.)

- [ ] **Step 3.2: Run to verify failure**

Run: `npx vitest run tests/unit/backend/vault/git/bootstrap.test.ts`
Expected: FAIL — `_audit/` still listed in ignores and not cleaned up.

- [ ] **Step 3.3: Update `RUNTIME_IGNORES` and add cleanup**

```typescript
// src/backend/vault/git/bootstrap.ts
-const RUNTIME_IGNORES = [
-  ".agent-brain/",
-  "_sessions/",
-  "_session-tracking/",
-  "_scheduler-state.json",
-  "_audit/",
-];
+const RUNTIME_IGNORES = [
+  ".agent-brain/",
+  "_sessions/",
+  "_session-tracking/",
+  "_scheduler-state.json",
+];
```

Add near the top of `ensureVaultGit`, right after `if (!wasRepo) await git.init();`:

```typescript
// Phase 4c cleanup: _audit/ is no longer produced (audit reads from
// git log). Remove any leftovers from earlier phases so a stale
// directory doesn't confuse the user.
await rmrf(join(opts.root, "_audit"));
```

And a local helper:

```typescript
import { rm } from "node:fs/promises";

async function rmrf(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
```

- [ ] **Step 3.4: Run to verify pass**

Run: `npx vitest run tests/unit/backend/vault/git/bootstrap.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 3.5: Commit**

```bash
git add src/backend/vault/git/bootstrap.ts tests/unit/backend/vault/git/bootstrap.test.ts
git commit -m "feat(vault): drop _audit/ ignore, clean up stale JSONL on startup"
```

---

## Task 4: Pure merge function

**Files:**

- Create: `src/backend/vault/parser/merge-memory.ts`
- Create: `tests/unit/backend/vault/parser/merge-memory.test.ts`

**Context:** The driver needs a pure function `mergeMemoryFiles(ancestor, ours, theirs)` that returns either the merged markdown or a machine-readable reason for giving up. All rules from spec §"Per-Field Merge Rules" land here. No IO, no subprocess, no logging.

Body-text diff3 uses `git merge-file` as a subprocess — **exception** to "no IO": we need diff3 semantics and reimplementing diff3 is out of scope. The function accepts an injected `diff3` callback so tests can stub it.

- [ ] **Step 4.1: Write failing tests**

Given the volume, split the test file into sections. One test per rule at minimum. Abbreviated here — write exhaustively against every field in the rules table.

```typescript
// tests/unit/backend/vault/parser/merge-memory.test.ts
import { describe, it, expect } from "vitest";
import { mergeMemoryFiles } from "../../../../../src/backend/vault/parser/merge-memory.js";
import { parseMemoryFile } from "../../../../../src/backend/vault/parser/memory-parser.js";

const base = (over: Record<string, unknown> = {}) =>
  [
    "---",
    "id: mem-1",
    "project_id: proj-1",
    "workspace_id: ws-1",
    `title: ${over.title ?? "hello"}`,
    `type: ${over.type ?? "fact"}`,
    `scope: ${over.scope ?? "workspace"}`,
    `tags: ${JSON.stringify(over.tags ?? ["a"])}`,
    `author: ${over.author ?? "alice"}`,
    "source: null",
    "session_id: null",
    `metadata: ${over.metadata === undefined ? "null" : JSON.stringify(over.metadata)}`,
    "embedding_model: null",
    "embedding_dimensions: null",
    `version: ${over.version ?? 1}`,
    "created: 2026-04-01T00:00:00.000Z",
    `updated: ${over.updated ?? "2026-04-20T10:00:00.000Z"}`,
    `verified: ${over.verified ?? "null"}`,
    `archived: ${over.archived ?? "null"}`,
    `verified_by: ${over.verified_by ?? "null"}`,
    "---",
    "",
    `# ${over.title ?? "hello"}`,
    "",
    `${over.content ?? "body"}`,
    "",
  ].join("\n");

const passthroughDiff3 = () => ({ clean: true as const, text: "" });

describe("mergeMemoryFiles", () => {
  it("returns { ok: true } with union-merged tags", async () => {
    const a = base({ tags: ["a"] });
    const o = base({ tags: ["a", "x"] });
    const t = base({ tags: ["a", "y"] });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    const merged = parseMemoryFile(res.merged).memory;
    expect(merged.tags).toEqual(["a", "x", "y"]);
  });

  it("picks the side with the later updated_at for LWW fields (title)", async () => {
    const a = base({ title: "base" });
    const o = base({ title: "ours", updated: "2026-04-20T10:00:00.000Z" });
    const t = base({ title: "theirs", updated: "2026-04-20T11:00:00.000Z" });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.title).toBe("theirs");
  });

  it("takes max of both updated_at timestamps", async () => {
    const a = base();
    const o = base({ updated: "2026-04-20T10:00:00.000Z" });
    const t = base({ updated: "2026-04-21T00:00:00.000Z" });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.updated_at.toISOString()).toBe(
      "2026-04-21T00:00:00.000Z",
    );
  });

  it("archived_at: once archived, stays", async () => {
    const a = base();
    const o = base({ archived: "2026-04-20T10:00:00.000Z" });
    const t = base({ archived: "null" });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.archived_at?.toISOString()).toBe(
      "2026-04-20T10:00:00.000Z",
    );
  });

  it("rejects on immutable-field divergence (project_id)", async () => {
    const a = base();
    const o = base();
    const t = a.replace("project_id: proj-1", "project_id: proj-X");
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/project_id/);
  });

  it("rejects on parse failure of any side", async () => {
    const res = await mergeMemoryFiles(base(), "not markdown", base(), {
      diff3: passthroughDiff3,
    });
    expect(res.ok).toBe(false);
  });

  it("metadata: per-key merge picks the side with later updated_at", async () => {
    const a = base({ metadata: { keep: 1 } });
    const o = base({
      metadata: { keep: 1, ours: "o" },
      updated: "2026-04-20T10:00:00.000Z",
    });
    const t = base({
      metadata: { keep: 1, theirs: "t" },
      updated: "2026-04-20T11:00:00.000Z",
    });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    const mergedMeta = parseMemoryFile(res.merged).memory.metadata;
    expect(mergedMeta).toEqual({ keep: 1, ours: "o", theirs: "t" });
  });

  it("verified_at/verified_by: take the pair with later verified_at", async () => {
    const a = base();
    const o = base({
      verified: "2026-04-19T00:00:00.000Z",
      verified_by: "alice",
    });
    const t = base({
      verified: "2026-04-20T00:00:00.000Z",
      verified_by: "bob",
    });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    const m = parseMemoryFile(res.merged).memory;
    expect(m.verified_at?.toISOString()).toBe("2026-04-20T00:00:00.000Z");
    expect(m.verified_by).toBe("bob");
  });

  it("falls back to LWW when diff3 reports conflict", async () => {
    const a = base({ content: "base-body" });
    const o = base({
      content: "ours-body",
      updated: "2026-04-20T10:00:00.000Z",
    });
    const t = base({
      content: "theirs-body",
      updated: "2026-04-21T00:00:00.000Z",
    });
    const res = await mergeMemoryFiles(a, o, t, {
      diff3: () => ({ clean: false as const }),
    });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.content.trim()).toBe(
      "theirs-body",
    );
  });
});
```

- [ ] **Step 4.2: Run to verify failure**

Run: `npx vitest run tests/unit/backend/vault/parser/merge-memory.test.ts`
Expected: FAIL — module not defined.

- [ ] **Step 4.3: Implement `mergeMemoryFiles`**

```typescript
// src/backend/vault/parser/merge-memory.ts
import { parseMemoryFile, serializeMemoryFile } from "./memory-parser.js";
import type { ParsedMemoryFile } from "./memory-parser.js";
import type { Memory } from "../../../types/memory.js";

export type MergeResult =
  | { ok: true; merged: string }
  | { ok: false; reason: string };

export interface Diff3Result {
  clean: boolean;
  text?: string;
}

export interface MergeOptions {
  /**
   * Three-way diff over body text. Called with (base, ours, theirs) as
   * raw strings. Returns the clean merged text or { clean: false } on
   * unresolvable conflict, in which case the caller falls back to LWW.
   */
  diff3: (
    base: string,
    ours: string,
    theirs: string,
  ) => Promise<Diff3Result> | Diff3Result;
}

export async function mergeMemoryFiles(
  ancestor: string,
  ours: string,
  theirs: string,
  opts: MergeOptions,
): Promise<MergeResult> {
  let a: ParsedMemoryFile, o: ParsedMemoryFile, t: ParsedMemoryFile;
  try {
    a = parseMemoryFile(ancestor);
    o = parseMemoryFile(ours);
    t = parseMemoryFile(theirs);
  } catch (err) {
    return { ok: false, reason: `parse: ${(err as Error).message}` };
  }

  // Immutable fields — bail if our/theirs disagree.
  for (const field of ["id", "project_id"] as const) {
    if (o.memory[field] !== t.memory[field]) {
      return { ok: false, reason: `immutable field diverged: ${field}` };
    }
  }
  if (o.memory.created_at.getTime() !== t.memory.created_at.getTime()) {
    return { ok: false, reason: "immutable field diverged: created_at" };
  }

  const later =
    o.memory.updated_at.getTime() >= t.memory.updated_at.getTime() ? o : t;
  const earlier = later === o ? t : o;

  // Body content via diff3, LWW fallback.
  const bodyResult = await opts.diff3(
    a.memory.content,
    o.memory.content,
    t.memory.content,
  );
  const mergedContent =
    bodyResult.clean && bodyResult.text !== undefined
      ? bodyResult.text
      : later.memory.content;

  const merged: Memory = {
    ...later.memory,
    content: mergedContent,
    // Monotonic
    updated_at: new Date(
      Math.max(o.memory.updated_at.getTime(), t.memory.updated_at.getTime()),
    ),
    archived_at: maxDate(o.memory.archived_at, t.memory.archived_at),
    verified_at: pickLaterNonNull(o.memory.verified_at, t.memory.verified_at),
    verified_by: pickLaterNonNull(o.memory.verified_at, t.memory.verified_at)
      ? o.memory.verified_at !== null &&
        (t.memory.verified_at === null ||
          o.memory.verified_at.getTime() >= t.memory.verified_at.getTime())
        ? o.memory.verified_by
        : t.memory.verified_by
      : null,
    // Union
    tags: unionSorted(o.memory.tags, t.memory.tags),
    // Per-key LWW on metadata
    metadata: mergeMetadata(o.memory, t.memory, later === o),
    // Derived
    flag_count: 0, // recomputed by serializer based on merged flags
    comment_count: 0,
    relationship_count: 0,
    last_comment_at: null,
  };

  // Body subsections: union by id. Comments & flags are append-only;
  // relationships keyed by (target, type).
  const comments = unionBy(o.comments, t.comments, (c) => c.id);
  const flags = unionBy(o.flags, t.flags, (f) => f.id);
  const relationships = unionBy(
    o.relationships,
    t.relationships,
    (r) => `${r.source_id}|${r.target_id}|${r.type}`,
  );

  const out: ParsedMemoryFile = {
    memory: {
      ...merged,
      flag_count: flags.filter((f) => f.resolved_at === null).length,
      comment_count: comments.length,
      relationship_count: relationships.length,
      last_comment_at:
        comments.length === 0
          ? null
          : new Date(Math.max(...comments.map((c) => c.created_at.getTime()))),
    },
    flags,
    comments,
    relationships,
  };

  return { ok: true, merged: serializeMemoryFile(out) };
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function pickLaterNonNull(a: Date | null, b: Date | null): Date | null {
  return maxDate(a, b);
}

function unionSorted(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null && b === null) return null;
  const set = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return Array.from(set).sort();
}

function mergeMetadata(
  a: Memory,
  b: Memory,
  aIsLater: boolean,
): Record<string, unknown> | null {
  if (a.metadata === null && b.metadata === null) return null;
  const winner = aIsLater ? a.metadata : b.metadata;
  const loser = aIsLater ? b.metadata : a.metadata;
  const out: Record<string, unknown> = { ...(loser ?? {}) };
  if (winner) for (const [k, v] of Object.entries(winner)) out[k] = v;
  return out;
}

function unionBy<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const x of a) seen.set(key(x), x);
  for (const x of b) seen.set(key(x), x); // theirs overwrites on collision
  return Array.from(seen.values());
}
```

- [ ] **Step 4.4: Run to verify pass**

Run: `npx vitest run tests/unit/backend/vault/parser/merge-memory.test.ts`
Expected: PASS (all tests).

- [ ] **Step 4.5: Commit**

```bash
git add src/backend/vault/parser/merge-memory.ts tests/unit/backend/vault/parser/merge-memory.test.ts
git commit -m "feat(vault): pure mergeMemoryFiles with per-field rules"
```

---

## Task 5: CLI wrapper — `src/cli/merge-memory.ts`

**Files:**

- Create: `src/cli/merge-memory.ts`
- Create: `tests/unit/cli/merge-memory.test.ts`
- Modify: `package.json` (add `"bin"` entry)
- Modify: `tsconfig.json` if `src/cli/` is not yet covered by includes (verify first)

**Context:** Git invokes the driver as `driver %A %O %B` (our/base/their). Writes merged result to `%A`, exit 0 = clean, exit 1 = conflict. Uses `git merge-file -p --diff3` as the diff3 backend (ships with git, matches git's own behavior for unified-patch output).

- [ ] **Step 5.1: Verify `tsconfig.json` includes `src/**/\*`\*\*

Run: `grep -n '"include"' tsconfig.json`
Expected: a glob that covers `src/**/*.ts`. If not, amend; but `src/` is already included in this repo per existing `src/server.ts` etc.

- [ ] **Step 5.2: Write failing test**

```typescript
// tests/unit/cli/merge-memory.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../../src/cli/merge-memory.js";

async function tmp(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "merge-"));
  const p = join(dir, "f.md");
  await writeFile(p, body, "utf8");
  return p;
}

const memoryMd = (title: string) =>
  [
    "---",
    "id: mem-1",
    "project_id: proj-1",
    "workspace_id: ws-1",
    `title: ${title}`,
    "type: fact",
    "scope: workspace",
    'tags: ["a"]',
    "author: alice",
    "source: null",
    "session_id: null",
    "metadata: null",
    "embedding_model: null",
    "embedding_dimensions: null",
    "version: 1",
    "created: 2026-04-01T00:00:00.000Z",
    "updated: 2026-04-20T10:00:00.000Z",
    "verified: null",
    "archived: null",
    "verified_by: null",
    "---",
    "",
    `# ${title}`,
    "",
    "body",
    "",
  ].join("\n");

describe("merge-memory CLI run()", () => {
  it("returns 0 and writes merged content to %A", async () => {
    const A = await tmp(memoryMd("ours"));
    const O = await tmp(memoryMd("base"));
    const B = await tmp(memoryMd("theirs"));
    const code = await run([A, O, B]);
    expect(code).toBe(0);
    const out = await readFile(A, "utf8");
    expect(out).toMatch(/title: /);
  });

  it("returns 1 on parse failure", async () => {
    const A = await tmp("not yaml");
    const O = await tmp(memoryMd("x"));
    const B = await tmp(memoryMd("y"));
    expect(await run([A, O, B])).toBe(1);
  });

  it("returns 1 on immutable-field divergence", async () => {
    const A = await tmp(memoryMd("ours"));
    const O = await tmp(memoryMd("base"));
    const theirs = memoryMd("theirs").replace(
      "project_id: proj-1",
      "project_id: proj-X",
    );
    const B = await tmp(theirs);
    expect(await run([A, O, B])).toBe(1);
  });

  it("prints a parse error to stderr on exit 1 (smoke)", async () => {
    const A = await tmp("not yaml");
    const O = await tmp(memoryMd("x"));
    const B = await tmp(memoryMd("y"));
    const errs: unknown[] = [];
    const origErr = console.error;
    console.error = (...args) => {
      errs.push(args);
    };
    try {
      await run([A, O, B]);
    } finally {
      console.error = origErr;
    }
    expect(errs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5.3: Run to verify failure**

Run: `npx vitest run tests/unit/cli/merge-memory.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 5.4: Implement CLI**

```typescript
// src/cli/merge-memory.ts
#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mergeMemoryFiles } from "../backend/vault/parser/merge-memory.js";
import type { Diff3Result } from "../backend/vault/parser/merge-memory.js";

/**
 * Git merge driver entry point. argv = [%A, %O, %B] (ours, ancestor, theirs)
 * per the driver spec; we rewrite %A with the merged content.
 */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length < 3) {
    console.error("usage: merge-memory %A %O %B");
    return 1;
  }
  const [ours, ancestor, theirs] = argv as [string, string, string];
  try {
    const [oursBody, ancestorBody, theirsBody] = await Promise.all([
      readFile(ours, "utf8"),
      readFile(ancestor, "utf8"),
      readFile(theirs, "utf8"),
    ]);
    const res = await mergeMemoryFiles(ancestorBody, oursBody, theirsBody, {
      diff3: gitMergeFile,
    });
    if (!res.ok) {
      console.error(`agent-brain-merge-memory: ${res.reason}`);
      return 1;
    }
    await writeFile(ours, res.merged, "utf8");
    return 0;
  } catch (err) {
    console.error(`agent-brain-merge-memory: ${(err as Error).message}`);
    return 1;
  }
}

// Uses `git merge-file -p` with three stdin sources delivered as tmp
// files. Returns clean text on exit 0, { clean: false } on exit 1
// (conflict). Exit >1 is a real error and escalates.
async function gitMergeFile(
  base: string,
  our: string,
  their: string,
): Promise<Diff3Result> {
  // Round-trip through temp files. git merge-file does not accept
  // pipes for base/their — only ours is stdin. Easiest path: three tmp
  // files + `-p` to stream merged result on stdout.
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mm-"));
  const [basePath, ourPath, theirPath] = await Promise.all([
    writeAndReturn(join(dir, "base"), base),
    writeAndReturn(join(dir, "ours"), our),
    writeAndReturn(join(dir, "theirs"), their),
  ]);
  return new Promise<Diff3Result>((resolve, reject) => {
    const child = spawn("git", ["merge-file", "-p", ourPath, basePath, theirPath]);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", () => {}); // suppress diagnostics
    child.on("error", reject);
    child.on("close", (code) => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (code === 0) resolve({ clean: true, text });
      else if (code === 1) resolve({ clean: false });
      else reject(new Error(`git merge-file exited ${code}`));
    });
  });

  async function writeAndReturn(p: string, body: string): Promise<string> {
    await writeFile(p, body, "utf8");
    return p;
  }
}

// ESM main-module check without top-level `import.meta` globbing.
if (process.argv[1] && process.argv[1].endsWith("merge-memory.js")) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
```

- [ ] **Step 5.5: Add `"bin"` entry to `package.json`**

```json
  "bin": {
    "agent-brain-merge-memory": "./dist/cli/merge-memory.js"
  },
```

Verify the build pipeline already emits to `dist/cli/`:

Run: `npm run build && ls dist/cli/merge-memory.js`
Expected: file exists after build.

- [ ] **Step 5.6: Run to verify pass**

Run: `npx vitest run tests/unit/cli/merge-memory.test.ts`
Expected: PASS.

- [ ] **Step 5.7: Commit**

```bash
git add src/cli/merge-memory.ts tests/unit/cli/merge-memory.test.ts package.json
git commit -m "feat(vault): add agent-brain-merge-memory git merge driver CLI"
```

---

## Task 6: Write `[merge "agent-brain-memory"]` driver config on bootstrap

**Files:**

- Create: `src/backend/vault/git/merge-driver-config.ts`
- Create: `tests/unit/backend/vault/git/merge-driver-config.test.ts`
- Modify: `src/backend/vault/git/bootstrap.ts` (call it)
- Modify: `tests/unit/backend/vault/git/bootstrap.test.ts` (assert config written)

**Context:** Every `VaultBackend.create` writes (idempotently) a `[merge "agent-brain-memory"]` section to `<root>/.git/config` with an absolute path to `dist/cli/merge-memory.js`. Absolute path resolution uses `require.resolve` so it works with npm-installed, npx-linked, and in-repo development installs.

- [ ] **Step 6.1: Write failing test**

```typescript
// tests/unit/backend/vault/git/merge-driver-config.test.ts
import { describe, it, expect } from "vitest";
import { simpleGit } from "simple-git";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMergeDriverConfig } from "../../../../../src/backend/vault/git/merge-driver-config.js";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";

describe("ensureMergeDriverConfig", () => {
  it("writes driver name + path to .git/config", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdc-"));
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    await git.init();
    await ensureMergeDriverConfig({ git, driverPath: "/abs/merge-memory.js" });
    const name = await git.raw([
      "config",
      "--local",
      "merge.agent-brain-memory.name",
    ]);
    const driver = await git.raw([
      "config",
      "--local",
      "merge.agent-brain-memory.driver",
    ]);
    expect(name.trim()).toBe("agent-brain memory-file merge");
    expect(driver.trim()).toBe('node "/abs/merge-memory.js" %A %O %B');
  });

  it("rewrites driver path on each call (self-heals)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdc-"));
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    await git.init();
    await ensureMergeDriverConfig({ git, driverPath: "/abs/old.js" });
    await ensureMergeDriverConfig({ git, driverPath: "/abs/new.js" });
    const driver = await git.raw([
      "config",
      "--local",
      "merge.agent-brain-memory.driver",
    ]);
    expect(driver.trim()).toBe('node "/abs/new.js" %A %O %B');
  });
});
```

- [ ] **Step 6.2: Run to verify failure**

Run: `npx vitest run tests/unit/backend/vault/git/merge-driver-config.test.ts`
Expected: FAIL.

- [ ] **Step 6.3: Implement config writer**

```typescript
// src/backend/vault/git/merge-driver-config.ts
import type { SimpleGit } from "simple-git";

export interface EnsureMergeDriverConfigOptions {
  git: SimpleGit;
  driverPath: string; // absolute path to dist/cli/merge-memory.js
}

export async function ensureMergeDriverConfig(
  opts: EnsureMergeDriverConfigOptions,
): Promise<void> {
  // Quote the driver path so spaces in the install location don't
  // break the merge subprocess. %A %O %B are substituted by git.
  const command = `node "${opts.driverPath}" %A %O %B`;
  // `config --local --replace-all` is the idempotent form; plain
  // `--add` would append duplicates across bootstraps.
  await opts.git.raw([
    "config",
    "--local",
    "--replace-all",
    "merge.agent-brain-memory.name",
    "agent-brain memory-file merge",
  ]);
  await opts.git.raw([
    "config",
    "--local",
    "--replace-all",
    "merge.agent-brain-memory.driver",
    command,
  ]);
}

/**
 * Resolves the absolute path to the compiled merge driver. Prefers the
 * installed package entry; falls back to the repo-local dist/ for
 * development clones.
 */
export function resolveDriverPath(): string {
  try {
    // Newer node has require.resolve available as a side channel via
    // createRequire; use that so this module stays ESM-clean.
    return createRequireSafe().resolve("agent-brain/dist/cli/merge-memory.js");
  } catch {
    // Dev fallback: assume the caller's dist/ sits next to this file's
    // compiled location (src/backend/vault/git/ → dist/backend/vault/git/).
    // That path is two ../s up then into cli/.
    // This is only used in-repo; production always resolves via the first branch.
    const url = new URL("../../../../cli/merge-memory.js", import.meta.url);
    return url.pathname;
  }
}

function createRequireSafe() {
  // Wrapped in a function so the test harness can stub it if needed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createRequire } =
    require("node:module") as typeof import("node:module");
  return createRequire(import.meta.url);
}
```

- [ ] **Step 6.4: Wire `ensureMergeDriverConfig` into bootstrap**

```typescript
// src/backend/vault/git/bootstrap.ts - after git.init() / user.identity setup
+import { ensureMergeDriverConfig, resolveDriverPath } from "./merge-driver-config.js";
...
   await ensureIdentity(git);
+  await ensureMergeDriverConfig({ git, driverPath: resolveDriverPath() });
   const ignoreChanged = await ensureGitignore(opts.root, opts.trackUsers);
```

- [ ] **Step 6.5: Add bootstrap test assertion**

```typescript
// tests/unit/backend/vault/git/bootstrap.test.ts — new case
it("writes the merge driver config on bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "vault-"));
  await ensureVaultGit({ root, trackUsers: false });
  const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
  const driver = await git.raw([
    "config",
    "--local",
    "merge.agent-brain-memory.driver",
  ]);
  expect(driver).toMatch(/node ".+merge-memory\.js" %A %O %B/);
});
```

- [ ] **Step 6.6: Run to verify pass**

Run: `npx vitest run tests/unit/backend/vault/git/merge-driver-config.test.ts tests/unit/backend/vault/git/bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 6.7: Commit**

```bash
git add src/backend/vault/git/merge-driver-config.ts src/backend/vault/git/bootstrap.ts tests/unit/backend/vault/git/merge-driver-config.test.ts tests/unit/backend/vault/git/bootstrap.test.ts
git commit -m "feat(vault): register agent-brain-memory merge driver in .git/config"
```

---

## Task 7: Swap `.gitattributes` from `*.md merge=union` to path-specific rules

**Files:**

- Modify: `src/backend/vault/git/bootstrap.ts`
- Modify: `tests/unit/backend/vault/git/bootstrap.test.ts`

**Context:** Replace the single union rule with three memory-path rules. Handle the upgrade path from Phase 4b vaults: if a committed `.gitattributes` already has `*.md merge=union`, the bootstrap rewrites it and commits via the existing `commitBootstrap` path.

- [ ] **Step 7.1: Write failing tests**

```typescript
// tests/unit/backend/vault/git/bootstrap.test.ts — append
it("writes the three memory-path merge=agent-brain-memory rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "vault-"));
  await ensureVaultGit({ root, trackUsers: true });
  const body = await readFile(join(root, ".gitattributes"), "utf8");
  expect(body).toMatch(
    /^workspaces\/\*\*\/memories\/\*\.md merge=agent-brain-memory$/m,
  );
  expect(body).toMatch(/^project\/memories\/\*\.md merge=agent-brain-memory$/m);
  expect(body).toMatch(
    /^users\/\*\*\/memories\/\*\.md merge=agent-brain-memory$/m,
  );
  expect(body).not.toMatch(/^\*\.md merge=union$/m);
});

it("migrates a Phase 4b vault by replacing *.md merge=union", async () => {
  const root = await mkdtemp(join(tmpdir(), "vault-"));
  // Simulate a Phase 4b bootstrap
  await writeFile(join(root, ".gitattributes"), "*.md merge=union\n", "utf8");
  const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
  await git.init();
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await git.add([".gitattributes"]);
  await git.commit("seed");

  await ensureVaultGit({ root, trackUsers: false });
  const body = await readFile(join(root, ".gitattributes"), "utf8");
  expect(body).not.toMatch(/merge=union/);
  expect(body).toMatch(/merge=agent-brain-memory/);
});
```

- [ ] **Step 7.2: Run to verify failure**

Expected: FAIL — old rule still written.

- [ ] **Step 7.3: Update rule table + writer**

```typescript
// src/backend/vault/git/bootstrap.ts
-const GITATTRIBUTES_RULE = "*.md merge=union";
+const LEGACY_ATTR_RULE = "*.md merge=union";
+const GITATTRIBUTES_RULES = [
+  "workspaces/**/memories/*.md merge=agent-brain-memory",
+  "project/memories/*.md merge=agent-brain-memory",
+  "users/**/memories/*.md merge=agent-brain-memory",
+];
```

Replace `ensureGitattributes` with an add-missing + remove-legacy implementation:

```typescript
async function ensureGitattributes(root: string): Promise<boolean> {
  const path = join(root, ".gitattributes");
  const existing = await readOrEmpty(path);
  const lines = existing.split(/\r?\n/);
  let changed = false;

  // Drop any active `*.md merge=union` line (ignore commented-out).
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === LEGACY_ATTR_RULE) {
      changed = true;
      return false;
    }
    return true;
  });

  // Add each required rule if not already present as a live rule.
  const activeSet = new Set(
    kept.map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#")),
  );
  const toAppend: string[] = [];
  for (const rule of GITATTRIBUTES_RULES) {
    if (!activeSet.has(rule)) {
      toAppend.push(rule);
      changed = true;
    }
  }

  if (!changed) return false;
  // Normalize trailing newline before appending.
  const trimmed = kept.join("\n").replace(/\n+$/, "");
  const body =
    (trimmed === "" ? "" : trimmed + "\n") +
    toAppend.join("\n") +
    (toAppend.length ? "\n" : "");
  await writeFile(path, body, "utf8");
  return true;
}
```

Update `assertRequiredRules` to assert each of the three new rules:

```typescript
async function assertRequiredRules(
  root: string,
  trackUsers: boolean,
): Promise<void> {
  const ignoreBody = await readOrEmpty(join(root, ".gitignore"));
  const ignoreLines = new Set(ignoreBody.split(/\r?\n/).map((l) => l.trim()));
  const required = trackUsers
    ? RUNTIME_IGNORES
    : [...RUNTIME_IGNORES, "users/"];
  for (const rule of required) {
    if (!ignoreLines.has(rule)) {
      throw new DomainError(
        `vault bootstrap failed: .gitignore is missing rule '${rule}'`,
        "VAULT_BOOTSTRAP_FAILED",
        500,
      );
    }
  }
  const attrBody = await readOrEmpty(join(root, ".gitattributes"));
  for (const rule of GITATTRIBUTES_RULES) {
    if (!hasActiveRule(attrBody, rule)) {
      throw new DomainError(
        `vault bootstrap failed: .gitattributes is missing rule '${rule}'`,
        "VAULT_BOOTSTRAP_FAILED",
        500,
      );
    }
  }
  if (hasActiveRule(attrBody, LEGACY_ATTR_RULE)) {
    throw new DomainError(
      `vault bootstrap failed: legacy '${LEGACY_ATTR_RULE}' still active`,
      "VAULT_BOOTSTRAP_FAILED",
      500,
    );
  }
}
```

- [ ] **Step 7.4: Run tests**

Run: `npx vitest run tests/unit/backend/vault/git/bootstrap.test.ts`
Expected: PASS (all).

- [ ] **Step 7.5: Commit**

```bash
git add src/backend/vault/git/bootstrap.ts tests/unit/backend/vault/git/bootstrap.test.ts
git commit -m "feat(vault): swap .gitattributes to path-specific merge=agent-brain-memory"
```

---

## Task 8: Integration — two-clone concurrent-edit merge smoke

**Files:**

- Create: `tests/integration/vault/merge-driver.test.ts`
- Reference (no changes): `tests/contract/repositories/_git-helpers.ts`

**Context:** Uses existing `setupBareAndTwoVaults`. Both clones edit the same memory's frontmatter concurrently (different tags added). Push A; B pulls. Assert: rebase succeeds (no `pull_conflict`), merged memory has **both sides' tag additions**, `git log` shows a single rebase commit on top of shared base. Also confirms the compiled CLI at `dist/cli/merge-memory.js` is actually invoked.

- [ ] **Step 8.1: Ensure build produces `dist/cli/merge-memory.js` for the integration test**

Integration tests run under `vitest` and rely on `tsx`/compiled output depending on the test config. Inspect `vitest.config.ts` to understand how the CLI will be resolved:

Run: `grep -n 'alias\|dist\|include' vitest.config.ts`

If the CLI is expected to run pre-build, adjust `resolveDriverPath()` fallback to use `tsx` or a loader; otherwise add a pre-test `npm run build` step for this one spec. Document this in the test's comment.

- [ ] **Step 8.2: Write the failing test**

```typescript
// tests/integration/vault/merge-driver.test.ts
import { describe, it, expect } from "vitest";
import { simpleGit } from "simple-git";
import { setupBareAndTwoVaults } from "../../contract/repositories/_git-helpers.js";
import { scrubGitEnv } from "../../../src/backend/vault/git/env.js";
import { VaultBackend } from "../../../src/backend/vault/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("merge driver — concurrent frontmatter edits", () => {
  it("merges tag additions from both sides without conflict", async () => {
    const { origin, a: pathA, b: pathB } = await setupBareAndTwoVaults();

    const backendA = await VaultBackend.create({
      root: pathA,
      embeddingDimensions: 32,
      remoteUrl: origin,
    });
    const backendB = await VaultBackend.create({
      root: pathB,
      embeddingDimensions: 32,
      remoteUrl: origin,
    });

    // Seed a memory from A, push.
    await backendA.workspaceRepo.upsert({ id: "ws-1", title: "WS" });
    const mem = await backendA.memoryRepo.create({
      content: "body",
      title: "t",
      type: "fact",
      scope: "workspace",
      workspace_id: "ws-1",
      user_id: "alice",
      tags: ["shared"],
    });
    await backendA.flushPushes();
    await backendB.pullFromRemote();

    // Concurrent edits: A adds tag "ours", B adds tag "theirs".
    await backendA.memoryRepo.update(mem.id, mem.version, {
      tags: ["shared", "ours"],
      actor: "alice",
    });
    await backendB.memoryRepo.update(mem.id, mem.version, {
      tags: ["shared", "theirs"],
      actor: "bob",
    });

    // Push A, pull B — B's pull should trigger the merge driver.
    await backendA.flushPushes();
    const pulled = await backendB.pullFromRemote();
    expect(pulled.conflict).toBe(false);

    const path = `workspaces/ws-1/memories/${mem.id}.md`;
    const body = await readFile(join(pathB, path), "utf8");
    expect(body).toMatch(/tags:.*shared/);
    expect(body).toMatch(/tags:.*ours/);
    expect(body).toMatch(/tags:.*theirs/);

    await backendA.close();
    await backendB.close();
  }, 60_000);
});
```

Note: the test uses public methods that may not exist on `VaultBackend` today (`flushPushes`, `pullFromRemote`). If these are not already exposed, expose thin wrappers here:

```typescript
// src/backend/vault/index.ts - add near the other public methods
async flushPushes(): Promise<void> {
  await this.pushQueue.flush();
}

async pullFromRemote(): Promise<{ conflict: boolean }> {
  const { syncFromRemote } = await import("./git/pull.js");
  const res = await syncFromRemote({ git: this.git });
  return { conflict: res.conflict };
}
```

If `PushQueue.flush()` and `syncFromRemote` don't match these signatures, adjust to what Phase 4b already exposes — do not invent new infra.

- [ ] **Step 8.3: Run to verify failure, iterate**

Run: `npx vitest run tests/integration/vault/merge-driver.test.ts`
Expected: initial FAIL — either module-wiring or driver-not-invoked. Common fixes:

- `.git/config` driver path resolves to a `dist/cli/merge-memory.js` that doesn't exist yet → `npm run build` first.
- `resolveDriverPath()` returns a path outside the worktree in dev → temporarily set `AGENT_BRAIN_MERGE_DRIVER_PATH` env override (add as an optional config path if needed).

- [ ] **Step 8.4: Run to verify pass**

Run: `npm run build && npx vitest run tests/integration/vault/merge-driver.test.ts`
Expected: PASS.

- [ ] **Step 8.5: Commit**

```bash
git add tests/integration/vault/merge-driver.test.ts src/backend/vault/index.ts
git commit -m "test(vault): two-clone merge-driver integration smoke"
```

---

## Task 9: Integration — `AuditService.getHistory` over real commits

**Files:**

- Create: `tests/integration/vault/audit-history.test.ts`

**Context:** End-to-end test that create + update + archive through `MemoryService` produce an audit history via the new git-log reader. Exercises trailer emission, the `git log --grep` query, and the `git show` blob re-parse path for the `updated` diff.

- [ ] **Step 9.1: Write the failing test**

```typescript
// tests/integration/vault/audit-history.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBackend } from "../../../src/backend/vault/index.js";
import { AuditService } from "../../../src/services/audit-service.js";

describe("vault AuditService.getHistory", () => {
  it("returns create/update/archive entries with correct shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-"));
    const backend = await VaultBackend.create({
      root,
      embeddingDimensions: 32,
    });
    const audit = new AuditService(backend.auditRepo, "proj-1");

    await backend.workspaceRepo.upsert({ id: "ws-1", title: "WS" });
    const mem = await backend.memoryRepo.create({
      content: "initial",
      title: "t",
      type: "fact",
      scope: "workspace",
      workspace_id: "ws-1",
      user_id: "alice",
      tags: ["x"],
    });
    await backend.memoryRepo.update(mem.id, mem.version, {
      content: "updated",
      tags: ["x", "y"],
      actor: "alice",
    });
    await backend.memoryRepo.archive([mem.id]);

    const entries = await audit.getHistory(mem.id);
    expect(entries.map((e) => e.action)).toEqual([
      "archived",
      "updated",
      "created",
    ]);

    const updated = entries.find((e) => e.action === "updated")!;
    expect(updated.diff).not.toBeNull();
    expect(updated.diff).toMatchObject({
      before: { content: "initial", tags: ["x"] },
      after: { content: "updated", tags: ["x", "y"] },
    });

    const created = entries.find((e) => e.action === "created")!;
    expect(created.diff).toBeNull();

    await backend.close();
  });
});
```

- [ ] **Step 9.2: Run to verify fail**

Run: `npx vitest run tests/integration/vault/audit-history.test.ts`
Expected: failures that surface real integration bugs (argv, path derivation, etc). Iterate.

- [ ] **Step 9.3: Run to verify pass**

Expected: PASS.

- [ ] **Step 9.4: Commit**

```bash
git add tests/integration/vault/audit-history.test.ts
git commit -m "test(vault): integration for AuditService.getHistory over git log"
```

---

## Task 10: Full suite, lint, typecheck, + final cleanup

- [ ] **Step 10.1: Run the whole suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 10.2: Run contract tests against both backends**

Run: `npx vitest run tests/contract/repositories/audit-repository.test.ts`
Expected: all green. If a pg-only test case fails because pg stored a Date where vault re-parses a Date, it's a test fixture drift issue — fix by normalizing the two sides in the test itself, not by changing vault behavior.

- [ ] **Step 10.3: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 10.4: Check for leftovers**

Run: `grep -rn "_audit/\|JSONL" src/ tests/` to ensure nothing still references the removed storage.

- [ ] **Step 10.5: Commit any tidy-ups, then open the PR**

```bash
git push -u origin feat/vault-backend-phase-4c-audit-merge
gh pr create --title "feat(vault): Phase 4c — audit on git log + smart merge driver" --body "$(cat <<'EOF'
## Summary
- `VaultAuditRepository` now reads from `git log --grep='^AB-Memory:' + git show` for `{before, after}` diffs; no more JSONL.
- New `agent-brain-memory` git merge driver (`src/cli/merge-memory.ts`) replaces `*.md merge=union` on memory-file paths. Per-field rules: set union (tags), monotonic max (updated_at, archived_at, verified_*), LWW by updated_at (title/content/etc), per-key merge (metadata).
- Bootstrap writes `.git/config` driver registration on every startup (self-heals install path).
- Phase 4b vaults migrate transparently via one reconcile commit on first 4c boot.

## Test plan
- [ ] Unit — `tests/unit/backend/vault/git/trailer-parser.test.ts`
- [ ] Unit — `tests/unit/backend/vault/repositories/audit-repository.test.ts`
- [ ] Unit — `tests/unit/backend/vault/parser/merge-memory.test.ts`
- [ ] Unit — `tests/unit/cli/merge-memory.test.ts`
- [ ] Unit — `tests/unit/backend/vault/git/merge-driver-config.test.ts`
- [ ] Unit — `tests/unit/backend/vault/git/bootstrap.test.ts`
- [ ] Contract — `tests/contract/repositories/audit-repository.test.ts` (both backends)
- [ ] Integration — `tests/integration/vault/merge-driver.test.ts`
- [ ] Integration — `tests/integration/vault/audit-history.test.ts`
- [ ] Full suite — `npm test`

Spec: `docs/superpowers/specs/2026-04-23-vault-backend-phase-4c-audit-merge-design.md`
Plan: `docs/superpowers/plans/2026-04-23-vault-backend-phase-4c-audit-merge.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

Before handing this plan off, verify:

- [ ] Every spec "Decisions" row maps to at least one task.
- [ ] No "TBD" / "implement later" / "add error handling" placeholders.
- [ ] Every task's TDD steps include actual test code + actual implementation code.
- [ ] Function signatures referenced in later tasks match what earlier tasks define (`mergeMemoryFiles`, `parseTrailers`, `ensureMergeDriverConfig`).
- [ ] Paths referenced in `Files:` blocks match what the task actually creates.
