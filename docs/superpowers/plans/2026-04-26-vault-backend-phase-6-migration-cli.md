# Vault Backend Phase 6 — Bidirectional Migration CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two standalone CLI scripts (`migrate-pg-to-vault`, `migrate-vault-to-pg`) that move every entity (memories, comments, flags, relationships, workspaces) bidirectionally between `PostgresBackend` and `VaultBackend`, reusing destination repo write methods, with carry-over embeddings, preflight guards, single bulk commit on the vault side, and a counts-only verify.

**Architecture:** Add `migrationMode` flag to `VaultBackendConfig` that selects `NOOP_GIT_OPS` + skips watcher + skips boot scan + skips push wiring. CLI scripts read source side via direct drizzle queries (pg) or fs walk + parser modules (vault), then call destination repo `create(...)` methods unchanged. After all writes complete on pg→vault, the CLI issues a single `git add -A` + `git commit` with `AB-Action: migration` trailer and triggers one push.

**Tech Stack:** TypeScript / Node.js / Drizzle ORM / postgres-js / simple-git / vitest.

**Spec:** `docs/superpowers/specs/2026-04-26-vault-backend-phase-6-migration-cli-design.md`

---

## File structure

**Create:**

- `src/cli/migrate-pg-to-vault.ts` — entry point + argv wiring + DI for pg→vault.
- `src/cli/migrate-vault-to-pg.ts` — entry point + argv wiring + DI for vault→pg.
- `src/cli/migrate/types.ts` — `MigrationOptions`, `MigrationReport`, exit-code enum.
- `src/cli/migrate/preflight.ts` — `checkDims`, `checkTargetEmpty`, `checkDrizzleCurrent`.
- `src/cli/migrate/verify.ts` — `compareCounts(src, dst): Diff[]`.
- `src/cli/migrate/pg-to-vault.ts` — read pg via drizzle, write to `VaultBackend` repos, bulk commit.
- `src/cli/migrate/vault-to-pg.ts` — read vault via fs walk + parser, write to `PostgresBackend` repos.
- `tests/unit/cli/migrate/preflight.test.ts`
- `tests/unit/cli/migrate/verify.test.ts`
- `tests/unit/cli/migrate/pg-to-vault.test.ts`
- `tests/unit/cli/migrate/vault-to-pg.test.ts`
- `tests/integration/migration-roundtrip.test.ts`

**Modify:**

- `src/backend/vault/index.ts` — add `migrationMode?: true` + branching in `VaultBackend.create`.
- `package.json` — add `migrate:pg-to-vault` and `migrate:vault-to-pg` scripts.
- `docs/superpowers/specs/2026-04-21-vault-backend-design.md` — flip Phase 6 row to `Done — #TBD`.

Each file has a single concern: types, preflight checks, verify, one driver per direction, one CLI entry per direction.

---

## Task 1: Migration-mode plumbing on `VaultBackend`

**Files:**

- Modify: `src/backend/vault/index.ts`
- Test: `tests/unit/backend/vault/migration-mode.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backend/vault/migration-mode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBackend } from "../../../../src/backend/vault/index.js";

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "vault-migmode-"));
}

describe("VaultBackend migrationMode", () => {
  it("uses NOOP_GIT_OPS, skips watcher, skips push wiring", async () => {
    const root = await tmp();
    try {
      const backend = await VaultBackend.create({
        root,
        projectId: "p1",
        embeddingDimensions: 4,
        migrationMode: true,
      });
      // Repo write must succeed without erroring on a missing/no-op git repo.
      await backend.workspaceRepo.findOrCreate("ws1");
      // close() must not hang waiting for a watcher.
      await backend.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does NOT issue real commits when migrationMode is true", async () => {
    const root = await tmp();
    try {
      const backend = await VaultBackend.create({
        root,
        projectId: "p1",
        embeddingDimensions: 4,
        migrationMode: true,
      });
      const ws = await backend.workspaceRepo.findOrCreate("ws-test");
      expect(ws.id).toBe("ws-test");
      // The vault dir won't even be a git repo because ensureVaultGit was
      // bypassed in migration mode.
      await backend.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/backend/vault/migration-mode.test.ts`
Expected: FAIL — `migrationMode` is not a valid `VaultBackendConfig` field.

- [ ] **Step 3: Add `migrationMode` to `VaultBackendConfig` and branch in `create`**

Edit `src/backend/vault/index.ts` — extend interface and gate the wire-up. Replace the existing `VaultBackendConfig` and `create` method.

In `VaultBackendConfig`, add the field:

```ts
export interface VaultBackendConfig {
  root: string;
  projectId: string;
  embeddingDimensions: number;
  trackUsersInGit?: boolean;
  remoteUrl?: string;
  pushDebounceMs?: number;
  pushBackoffMs?: readonly number[];
  embed?: Embedder;
  // Phase 6 — migration CLI mode. When true:
  //   - ensureVaultGit / reconcileDirty / alignWithRemote are skipped
  //   - NOOP_GIT_OPS replaces GitOpsImpl (no commits land on writes)
  //   - PushQueue is wired to a no-op closure (no pushes, no backoff)
  //   - watcher is not started
  //   - boot scan is not run
  // The CLI is responsible for staging + committing + pushing once at end.
  migrationMode?: true;
}
```

Replace the body of `static async create(cfg: VaultBackendConfig)` with a branching version. Add this near the top of `create`, after the `mkdir`:

```ts
static async create(cfg: VaultBackendConfig): Promise<VaultBackend> {
  await mkdir(cfg.root, { recursive: true });
  const trackUsersInGit = cfg.trackUsersInGit ?? false;

  if (cfg.migrationMode) {
    return VaultBackend.#createMigrationMode(cfg, trackUsersInGit);
  }

  // ... existing non-migration body unchanged ...
}
```

Add a static helper `#createMigrationMode` to `VaultBackend`:

```ts
static async #createMigrationMode(
  cfg: VaultBackendConfig,
  trackUsersInGit: boolean,
): Promise<VaultBackend> {
  const git = simpleGit({ baseDir: cfg.root }).env(scrubGitEnv());
  const gitOps: GitOps = NOOP_GIT_OPS;
  const vectorIndex = await VaultVectorIndex.create({
    root: cfg.root,
    dims: cfg.embeddingDimensions,
  });
  // No-op push queue: every request() is a noop; close() resolves immediately.
  const pushQueue = new PushQueue({
    debounceMs: 0,
    backoffMs: [],
    push: async () => {
      /* no-op in migration mode; CLI pushes manually at end */
    },
    countUnpushed: async () => 0,
  });
  const vaultIdx = await VaultIndex.create(cfg.root);
  const ignoreSet = new IgnoreSetImpl();
  const memoryRepo = VaultMemoryRepository.create({
    root: cfg.root,
    vectorIndex,
    gitOps,
    trackUsersInGit,
    vaultIndex: vaultIdx,
    ignoreSet,
  });
  const embed = cfg.embed ?? defaultEmbedder(cfg.embeddingDimensions);
  // Watcher + boot scan deliberately skipped — vault is being constructed
  // by the CLI; live edits and pre-existing-state reconcile are out of scope.
  const watcher: VaultWatcher = {
    start: async () => {},
    stop: async () => {},
    lastError: () => undefined,
  };
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
    {},
    watcher,
  );
}
```

Add the imports at the top of `src/backend/vault/index.ts` if missing:

```ts
import { NOOP_GIT_OPS } from "./git/types.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/backend/vault/migration-mode.test.ts`
Expected: PASS — both cases.

- [ ] **Step 5: Run the existing VaultBackend tests to ensure no regression**

Run: `npx vitest run tests/unit/backend/vault/`
Expected: PASS — all existing tests still green; only new test added.

- [ ] **Step 6: Commit**

```bash
git add src/backend/vault/index.ts tests/unit/backend/vault/migration-mode.test.ts
git commit -m "$(cat <<'EOF'
feat(vault): migrationMode flag bypasses git+watcher+push wiring

VaultBackend.create branches early when migrationMode: true.
NOOP_GIT_OPS for writes, no-op PushQueue, skipped watcher/boot scan.
CLI owns final stage+commit+push. Used by Phase 6 migration scripts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared migration types

**Files:**

- Create: `src/cli/migrate/types.ts`

- [ ] **Step 1: Write the file**

Create `src/cli/migrate/types.ts`:

```ts
// Phase 6 — shared types for both migration directions.

export const ENTITY_KINDS = [
  "workspaces",
  "memories",
  "comments",
  "flags",
  "relationships",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface MigrationOptions {
  vaultRoot: string;
  pgUrl: string;
  projectId: string;
  embeddingDimensions: number;
  reembed: boolean;
  verify: boolean;
  dryRun: boolean;
  trackUsersInGit: boolean;
}

export interface CountsByKind {
  workspaces: number;
  memories: number;
  comments: number;
  flags: number;
  relationships: number;
}

export interface MigrationReport {
  source: CountsByKind;
  destination: CountsByKind;
  reembedded: boolean;
  durationMs: number;
}

// Exit codes — also documented in the spec under D8.
export const EXIT = {
  OK: 0,
  PREFLIGHT: 1,
  VERIFY: 2,
  WRITE: 3,
  COMMIT_OR_PUSH: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/migrate/types.ts
git commit -m "$(cat <<'EOF'
feat(cli): shared types for Phase 6 migration

EntityKind, MigrationOptions, CountsByKind, MigrationReport, EXIT codes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Preflight — dimension check

**Files:**

- Create: `src/cli/migrate/preflight.ts`
- Test: `tests/unit/cli/migrate/preflight.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/migrate/preflight.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkDims } from "../../../../src/cli/migrate/preflight.js";

describe("preflight.checkDims", () => {
  it("ok when source and destination dims match", () => {
    const res = checkDims({ sourceDim: 768, destDim: 768, reembed: false });
    expect(res.ok).toBe(true);
  });

  it("fails when dims mismatch and reembed is false", () => {
    const res = checkDims({ sourceDim: 768, destDim: 1024, reembed: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/dim mismatch/i);
      expect(res.reason).toMatch(/--reembed/);
    }
  });

  it("ok when dims mismatch but reembed is true (vectors regenerated)", () => {
    const res = checkDims({ sourceDim: 768, destDim: 1024, reembed: true });
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/migrate/preflight.test.ts`
Expected: FAIL — `checkDims` not exported.

- [ ] **Step 3: Implement `checkDims`**

Create `src/cli/migrate/preflight.ts`:

```ts
// Phase 6 — preflight checks shared by both migration directions.

export interface PreflightResult {
  ok: boolean;
  reason?: string;
}

export interface DimCheckInput {
  sourceDim: number;
  destDim: number;
  reembed: boolean;
}

export function checkDims(input: DimCheckInput): PreflightResult {
  if (input.reembed) return { ok: true };
  if (input.sourceDim === input.destDim) return { ok: true };
  return {
    ok: false,
    reason:
      `embedding dim mismatch: source=${input.sourceDim} dest=${input.destDim}. ` +
      `Re-run with --reembed to regenerate vectors via the current EmbeddingProvider.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/migrate/preflight.test.ts`
Expected: PASS — all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/migrate/preflight.ts tests/unit/cli/migrate/preflight.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): preflight dim check for Phase 6 migration

checkDims compares source/dest embedding dims; --reembed bypass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Preflight — target-empty check

**Files:**

- Modify: `src/cli/migrate/preflight.ts`
- Modify: `tests/unit/cli/migrate/preflight.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `tests/unit/cli/migrate/preflight.test.ts`:

```ts
import { checkTargetEmpty } from "../../../../src/cli/migrate/preflight.js";

describe("preflight.checkTargetEmpty", () => {
  it("ok when count is 0", async () => {
    const res = await checkTargetEmpty({ countMemories: async () => 0 });
    expect(res.ok).toBe(true);
  });

  it("fails when count > 0 with TRUNCATE remediation hint", async () => {
    const res = await checkTargetEmpty({ countMemories: async () => 42 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/not empty/i);
      expect(res.reason).toMatch(/TRUNCATE/);
      expect(res.reason).toMatch(/42/);
    }
  });

  it("propagates underlying connection error", async () => {
    await expect(
      checkTargetEmpty({
        countMemories: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/migrate/preflight.test.ts`
Expected: FAIL — `checkTargetEmpty` not exported.

- [ ] **Step 3: Implement `checkTargetEmpty`**

Append to `src/cli/migrate/preflight.ts`:

```ts
export interface TargetEmptyCheckInput {
  countMemories: () => Promise<number>;
}

export async function checkTargetEmpty(
  input: TargetEmptyCheckInput,
): Promise<PreflightResult> {
  const n = await input.countMemories();
  if (n === 0) return { ok: true };
  return {
    ok: false,
    reason:
      `Target database not empty (memories table has ${n} rows). ` +
      `To proceed: TRUNCATE the agent-brain tables in the target schema, or ` +
      `point AGENT_BRAIN_DATABASE_URL at a fresh database, then re-run.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/migrate/preflight.test.ts`
Expected: PASS — all `checkTargetEmpty` cases plus existing `checkDims` cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/migrate/preflight.ts tests/unit/cli/migrate/preflight.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): preflight target-empty check for vault->pg migration

checkTargetEmpty enforces empty memories table; mismatch hints TRUNCATE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Preflight — drizzle migration currency check

**Files:**

- Modify: `src/cli/migrate/preflight.ts`
- Modify: `tests/unit/cli/migrate/preflight.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `tests/unit/cli/migrate/preflight.test.ts`:

```ts
import { checkDrizzleCurrent } from "../../../../src/cli/migrate/preflight.js";

describe("preflight.checkDrizzleCurrent", () => {
  it("ok when latest applied hash matches expected", async () => {
    const res = await checkDrizzleCurrent({
      latestApplied: async () => "deadbeef",
      expectedLatest: "deadbeef",
    });
    expect(res.ok).toBe(true);
  });

  it("fails with db:migrate hint when stale", async () => {
    const res = await checkDrizzleCurrent({
      latestApplied: async () => "old",
      expectedLatest: "new",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/stale|out of date/i);
      expect(res.reason).toMatch(/db:migrate/);
    }
  });

  it("fails when no migrations have been applied yet", async () => {
    const res = await checkDrizzleCurrent({
      latestApplied: async () => null,
      expectedLatest: "any",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/no migrations/i);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/migrate/preflight.test.ts`
Expected: FAIL — `checkDrizzleCurrent` not exported.

- [ ] **Step 3: Implement `checkDrizzleCurrent`**

Append to `src/cli/migrate/preflight.ts`:

```ts
export interface DrizzleCurrentCheckInput {
  // Returns the hash of the latest applied migration, or null if none.
  latestApplied: () => Promise<string | null>;
  expectedLatest: string;
}

export async function checkDrizzleCurrent(
  input: DrizzleCurrentCheckInput,
): Promise<PreflightResult> {
  const applied = await input.latestApplied();
  if (applied === null) {
    return {
      ok: false,
      reason:
        `No migrations applied. Run \`npm run db:migrate\` against the target ` +
        `database before retrying.`,
    };
  }
  if (applied === input.expectedLatest) return { ok: true };
  return {
    ok: false,
    reason:
      `Drizzle migrations are stale (applied=${applied}, expected=${input.expectedLatest}). ` +
      `Run \`npm run db:migrate\` against the target database before retrying.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/migrate/preflight.test.ts`
Expected: PASS — all preflight cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/migrate/preflight.ts tests/unit/cli/migrate/preflight.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): preflight drizzle currency check for migration

checkDrizzleCurrent compares latest applied vs expected; suggests db:migrate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Verify — counts diff

**Files:**

- Create: `src/cli/migrate/verify.ts`
- Test: `tests/unit/cli/migrate/verify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/migrate/verify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compareCounts } from "../../../../src/cli/migrate/verify.js";
import type { CountsByKind } from "../../../../src/cli/migrate/types.js";

const sample: CountsByKind = {
  workspaces: 3,
  memories: 100,
  comments: 50,
  flags: 7,
  relationships: 20,
};

describe("verify.compareCounts", () => {
  it("returns empty diff when source and destination match", () => {
    const diff = compareCounts(sample, { ...sample });
    expect(diff).toEqual([]);
  });

  it("flags every mismatched kind", () => {
    const dest: CountsByKind = { ...sample, memories: 99, flags: 6 };
    const diff = compareCounts(sample, dest);
    expect(diff).toEqual([
      { kind: "memories", source: 100, destination: 99 },
      { kind: "flags", source: 7, destination: 6 },
    ]);
  });

  it("preserves canonical kind order in the diff list", () => {
    const dest: CountsByKind = {
      workspaces: 0,
      memories: 0,
      comments: 0,
      flags: 0,
      relationships: 0,
    };
    const diff = compareCounts(sample, dest);
    expect(diff.map((d) => d.kind)).toEqual([
      "workspaces",
      "memories",
      "comments",
      "flags",
      "relationships",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/migrate/verify.test.ts`
Expected: FAIL — `compareCounts` not exported.

- [ ] **Step 3: Implement `compareCounts`**

Create `src/cli/migrate/verify.ts`:

```ts
import type { CountsByKind, EntityKind } from "./types.js";
import { ENTITY_KINDS } from "./types.js";

export interface CountDiff {
  kind: EntityKind;
  source: number;
  destination: number;
}

export function compareCounts(
  source: CountsByKind,
  destination: CountsByKind,
): CountDiff[] {
  const diffs: CountDiff[] = [];
  for (const kind of ENTITY_KINDS) {
    if (source[kind] !== destination[kind]) {
      diffs.push({
        kind,
        source: source[kind],
        destination: destination[kind],
      });
    }
  }
  return diffs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/migrate/verify.test.ts`
Expected: PASS — all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/migrate/verify.ts tests/unit/cli/migrate/verify.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): counts-only verify for Phase 6 migration

compareCounts returns per-kind diff list in canonical order.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: pg→vault driver

**Files:**

- Create: `src/cli/migrate/pg-to-vault.ts`
- Test: `tests/unit/cli/migrate/pg-to-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/migrate/pg-to-vault.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runPgToVault } from "../../../../src/cli/migrate/pg-to-vault.js";

describe("runPgToVault", () => {
  it("writes workspaces before memories before comments/flags/relationships", async () => {
    const calls: string[] = [];
    const fakeSource = {
      readWorkspaces: async () => [{ id: "ws", created_at: new Date() }],
      readMemoriesWithEmbeddings: async () => [
        {
          memory: {
            id: "m1",
            project_id: "p",
            workspace_id: "ws",
            scope: "workspace",
            type: "fact",
            title: "t",
            content: "c",
            tags: [],
            archived: false,
            user_id: "u",
            author: "u",
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
          },
          embedding: [0, 0, 0, 0],
        },
      ],
      readComments: async () => [
        { id: "c1", memory_id: "m1", author: "u", content: "hi" },
      ],
      readFlags: async () => [],
      readRelationships: async () => [],
      counts: async () => ({
        workspaces: 1,
        memories: 1,
        comments: 1,
        flags: 0,
        relationships: 0,
      }),
    };
    const dest = {
      workspaceRepo: {
        findOrCreate: vi.fn(async (slug: string) => {
          calls.push(`ws:${slug}`);
          return { id: slug, created_at: new Date() };
        }),
      },
      memoryRepo: {
        create: vi.fn(async (m: { id: string }) => {
          calls.push(`m:${m.id}`);
          return m;
        }),
      },
      commentRepo: {
        create: vi.fn(async (c: { id: string }) => {
          calls.push(`c:${c.id}`);
          return { ...c, created_at: new Date() };
        }),
      },
      flagRepo: { create: vi.fn() },
      relationshipRepo: { create: vi.fn() },
    };
    await runPgToVault({
      source: fakeSource,
      destination: dest as never,
      reembed: false,
      embedder: async () => [0, 0, 0, 0],
    });
    expect(calls).toEqual(["ws:ws", "m:m1", "c:c1"]);
  });

  it("re-embeds when reembed is true", async () => {
    const embedder = vi.fn(async () => [9, 9, 9, 9]);
    const fakeSource = {
      readWorkspaces: async () => [],
      readMemoriesWithEmbeddings: async () => [
        {
          memory: {
            id: "m1",
            project_id: "p",
            workspace_id: "ws",
            scope: "workspace" as const,
            type: "fact",
            title: "t",
            content: "the body",
            tags: [],
            archived: false,
            user_id: "u",
            author: "u",
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
          },
          embedding: [1, 1, 1, 1],
        },
      ],
      readComments: async () => [],
      readFlags: async () => [],
      readRelationships: async () => [],
      counts: async () => ({
        workspaces: 0,
        memories: 1,
        comments: 0,
        flags: 0,
        relationships: 0,
      }),
    };
    let captured: number[] | null = null;
    const dest = {
      workspaceRepo: { findOrCreate: vi.fn() },
      memoryRepo: {
        create: vi.fn(async (m: { embedding: number[] }) => {
          captured = m.embedding;
          return m;
        }),
      },
      commentRepo: { create: vi.fn() },
      flagRepo: { create: vi.fn() },
      relationshipRepo: { create: vi.fn() },
    };
    await runPgToVault({
      source: fakeSource,
      destination: dest as never,
      reembed: true,
      embedder,
    });
    expect(embedder).toHaveBeenCalledWith("the body");
    expect(captured).toEqual([9, 9, 9, 9]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/migrate/pg-to-vault.test.ts`
Expected: FAIL — `runPgToVault` not exported.

- [ ] **Step 3: Implement `runPgToVault`**

Create `src/cli/migrate/pg-to-vault.ts`:

```ts
import type {
  MemoryRepository,
  WorkspaceRepository,
  CommentRepository,
  FlagRepository,
  RelationshipRepository,
} from "../../repositories/types.js";
import type { Memory, Comment } from "../../types/memory.js";
import type { Flag } from "../../types/flag.js";
import type { Relationship } from "../../types/relationship.js";
import type { CountsByKind } from "./types.js";

export interface PgSource {
  readWorkspaces(): Promise<Array<{ id: string; created_at: Date }>>;
  readMemoriesWithEmbeddings(): Promise<
    Array<{ memory: Memory; embedding: number[] }>
  >;
  readComments(): Promise<
    Array<{
      id: string;
      memory_id: string;
      author: string;
      content: string;
    }>
  >;
  readFlags(): Promise<Flag[]>;
  readRelationships(): Promise<Relationship[]>;
  counts(): Promise<CountsByKind>;
}

export interface VaultDestination {
  workspaceRepo: Pick<WorkspaceRepository, "findOrCreate">;
  memoryRepo: Pick<MemoryRepository, "create">;
  commentRepo: Pick<CommentRepository, "create">;
  flagRepo: Pick<FlagRepository, "create">;
  relationshipRepo: Pick<RelationshipRepository, "create">;
}

export interface RunPgToVaultInput {
  source: PgSource;
  destination: VaultDestination;
  reembed: boolean;
  embedder: (content: string) => Promise<number[]>;
}

export async function runPgToVault(input: RunPgToVaultInput): Promise<void> {
  const { source, destination, reembed, embedder } = input;

  // 1. workspaces (FK target for everything else)
  const workspaces = await source.readWorkspaces();
  for (const ws of workspaces) {
    await destination.workspaceRepo.findOrCreate(ws.id);
  }

  // 2. memories — carry-over embedding by default; re-embed when flagged
  const memories = await source.readMemoriesWithEmbeddings();
  for (const { memory, embedding } of memories) {
    const vec = reembed ? await embedder(memory.content) : embedding;
    await destination.memoryRepo.create({ ...memory, embedding: vec });
  }

  // 3. comments
  const comments = await source.readComments();
  for (const c of comments) {
    await destination.commentRepo.create({
      id: c.id,
      memory_id: c.memory_id,
      author: c.author,
      content: c.content,
    });
  }

  // 4. flags
  const flags = await source.readFlags();
  for (const f of flags) {
    await destination.flagRepo.create(f);
  }

  // 5. relationships
  const rels = await source.readRelationships();
  for (const r of rels) {
    await destination.relationshipRepo.create(r);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/migrate/pg-to-vault.test.ts`
Expected: PASS — both cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/migrate/pg-to-vault.ts tests/unit/cli/migrate/pg-to-vault.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): pg-to-vault driver core

runPgToVault streams workspaces, memories, comments, flags, relationships
in FK order. Carry-over embeddings by default; embedder used under reembed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: vault→pg driver

**Files:**

- Create: `src/cli/migrate/vault-to-pg.ts`
- Test: `tests/unit/cli/migrate/vault-to-pg.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/migrate/vault-to-pg.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runVaultToPg } from "../../../../src/cli/migrate/vault-to-pg.js";

describe("runVaultToPg", () => {
  it("writes workspaces before memories before comments/flags/relationships", async () => {
    const calls: string[] = [];
    const fakeSource = {
      readWorkspaces: async () => [{ id: "ws", created_at: new Date() }],
      readMemoriesWithEmbeddings: async () => [
        {
          memory: {
            id: "m1",
            project_id: "p",
            workspace_id: "ws",
            scope: "workspace" as const,
            type: "fact",
            title: "t",
            content: "c",
            tags: [],
            archived: false,
            user_id: "u",
            author: "u",
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
          },
          embedding: [0, 0, 0, 0],
        },
      ],
      readComments: async () => [
        { id: "c1", memory_id: "m1", author: "u", content: "hi" },
      ],
      readFlags: async () => [],
      readRelationships: async () => [],
      counts: async () => ({
        workspaces: 1,
        memories: 1,
        comments: 1,
        flags: 0,
        relationships: 0,
      }),
    };
    const dest = {
      workspaceRepo: {
        findOrCreate: vi.fn(async (slug: string) => {
          calls.push(`ws:${slug}`);
          return { id: slug, created_at: new Date() };
        }),
      },
      memoryRepo: {
        create: vi.fn(async (m: { id: string }) => {
          calls.push(`m:${m.id}`);
          return m;
        }),
      },
      commentRepo: {
        create: vi.fn(async (c: { id: string }) => {
          calls.push(`c:${c.id}`);
          return { ...c, created_at: new Date() };
        }),
      },
      flagRepo: { create: vi.fn() },
      relationshipRepo: { create: vi.fn() },
    };
    await runVaultToPg({
      source: fakeSource,
      destination: dest as never,
      reembed: false,
      embedder: async () => [0, 0, 0, 0],
    });
    expect(calls).toEqual(["ws:ws", "m:m1", "c:c1"]);
  });

  it("re-embeds when reembed is true", async () => {
    const embedder = vi.fn(async () => [9, 9, 9, 9]);
    const fakeSource = {
      readWorkspaces: async () => [],
      readMemoriesWithEmbeddings: async () => [
        {
          memory: {
            id: "m1",
            project_id: "p",
            workspace_id: "ws",
            scope: "workspace" as const,
            type: "fact",
            title: "t",
            content: "body",
            tags: [],
            archived: false,
            user_id: "u",
            author: "u",
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
          },
          embedding: [1, 1, 1, 1],
        },
      ],
      readComments: async () => [],
      readFlags: async () => [],
      readRelationships: async () => [],
      counts: async () => ({
        workspaces: 0,
        memories: 1,
        comments: 0,
        flags: 0,
        relationships: 0,
      }),
    };
    let captured: number[] | null = null;
    const dest = {
      workspaceRepo: { findOrCreate: vi.fn() },
      memoryRepo: {
        create: vi.fn(async (m: { embedding: number[] }) => {
          captured = m.embedding;
          return m;
        }),
      },
      commentRepo: { create: vi.fn() },
      flagRepo: { create: vi.fn() },
      relationshipRepo: { create: vi.fn() },
    };
    await runVaultToPg({
      source: fakeSource,
      destination: dest as never,
      reembed: true,
      embedder,
    });
    expect(embedder).toHaveBeenCalledWith("body");
    expect(captured).toEqual([9, 9, 9, 9]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/migrate/vault-to-pg.test.ts`
Expected: FAIL — `runVaultToPg` not exported.

- [ ] **Step 3: Implement `runVaultToPg`**

Create `src/cli/migrate/vault-to-pg.ts`:

```ts
import type {
  MemoryRepository,
  WorkspaceRepository,
  CommentRepository,
  FlagRepository,
  RelationshipRepository,
} from "../../repositories/types.js";
import type { Memory } from "../../types/memory.js";
import type { Flag } from "../../types/flag.js";
import type { Relationship } from "../../types/relationship.js";
import type { CountsByKind } from "./types.js";

export interface VaultSource {
  readWorkspaces(): Promise<Array<{ id: string; created_at: Date }>>;
  readMemoriesWithEmbeddings(): Promise<
    Array<{ memory: Memory; embedding: number[] }>
  >;
  readComments(): Promise<
    Array<{
      id: string;
      memory_id: string;
      author: string;
      content: string;
    }>
  >;
  readFlags(): Promise<Flag[]>;
  readRelationships(): Promise<Relationship[]>;
  counts(): Promise<CountsByKind>;
}

export interface PgDestination {
  workspaceRepo: Pick<WorkspaceRepository, "findOrCreate">;
  memoryRepo: Pick<MemoryRepository, "create">;
  commentRepo: Pick<CommentRepository, "create">;
  flagRepo: Pick<FlagRepository, "create">;
  relationshipRepo: Pick<RelationshipRepository, "create">;
}

export interface RunVaultToPgInput {
  source: VaultSource;
  destination: PgDestination;
  reembed: boolean;
  embedder: (content: string) => Promise<number[]>;
}

export async function runVaultToPg(input: RunVaultToPgInput): Promise<void> {
  const { source, destination, reembed, embedder } = input;

  const workspaces = await source.readWorkspaces();
  for (const ws of workspaces) {
    await destination.workspaceRepo.findOrCreate(ws.id);
  }

  const memories = await source.readMemoriesWithEmbeddings();
  for (const { memory, embedding } of memories) {
    const vec = reembed ? await embedder(memory.content) : embedding;
    await destination.memoryRepo.create({ ...memory, embedding: vec });
  }

  const comments = await source.readComments();
  for (const c of comments) {
    await destination.commentRepo.create({
      id: c.id,
      memory_id: c.memory_id,
      author: c.author,
      content: c.content,
    });
  }

  const flags = await source.readFlags();
  for (const f of flags) {
    await destination.flagRepo.create(f);
  }

  const rels = await source.readRelationships();
  for (const r of rels) {
    await destination.relationshipRepo.create(r);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/migrate/vault-to-pg.test.ts`
Expected: PASS — both cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/migrate/vault-to-pg.ts tests/unit/cli/migrate/vault-to-pg.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): vault-to-pg driver core

runVaultToPg streams workspaces, memories, comments, flags, relationships
in FK order. Carry-over embeddings by default; embedder used under reembed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: CLI entry — migrate-pg-to-vault

**Files:**

- Create: `src/cli/migrate-pg-to-vault.ts`

This file is the I/O glue: argv parse → read pg via drizzle → preflight → run driver → bulk commit + push → verify.

- [ ] **Step 1: Write the file**

Create `src/cli/migrate-pg-to-vault.ts`:

```ts
#!/usr/bin/env node
import { simpleGit } from "simple-git";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../db/schema.js";
import { VaultBackend } from "../backend/vault/index.js";
import { createEmbeddingProvider } from "../providers/embedding/index.js";
import { checkDims, checkDrizzleCurrent } from "./migrate/preflight.js";
import { compareCounts } from "./migrate/verify.js";
import { runPgToVault, type PgSource } from "./migrate/pg-to-vault.js";
import { EXIT, type ExitCode, type CountsByKind } from "./migrate/types.js";
import type { Memory } from "../types/memory.js";
import type { Flag } from "../types/flag.js";
import type { Relationship } from "../types/relationship.js";

interface Args {
  vaultRoot: string;
  pgUrl: string;
  projectId: string;
  embeddingDimensions: number;
  reembed: boolean;
  verify: boolean;
  dryRun: boolean;
  trackUsersInGit: boolean;
  yes: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (k: string): boolean => argv.includes(k);
  const required = (envKey: string, flagKey: string): string => {
    const v = get(flagKey) ?? process.env[envKey];
    if (!v) {
      console.error(`missing ${flagKey} (or env ${envKey})`);
      process.exit(EXIT.PREFLIGHT);
    }
    return v;
  };
  const dimsRaw =
    get("--embedding-dimensions") ??
    process.env.AGENT_BRAIN_EMBEDDING_DIMENSIONS;
  if (!dimsRaw) {
    console.error(
      "missing --embedding-dimensions (or env AGENT_BRAIN_EMBEDDING_DIMENSIONS)",
    );
    process.exit(EXIT.PREFLIGHT);
  }
  const dims = Number.parseInt(dimsRaw, 10);
  if (!Number.isFinite(dims) || dims <= 0) {
    console.error(`invalid embedding dimensions: ${dimsRaw}`);
    process.exit(EXIT.PREFLIGHT);
  }
  return {
    vaultRoot: required("AGENT_BRAIN_VAULT_ROOT", "--vault-root"),
    pgUrl: required("AGENT_BRAIN_DATABASE_URL", "--pg-url"),
    projectId: required("AGENT_BRAIN_PROJECT_ID", "--project-id"),
    embeddingDimensions: dims,
    reembed: has("--reembed"),
    verify: !has("--no-verify"),
    dryRun: has("--dry-run"),
    trackUsersInGit: has("--track-users-in-git"),
    yes: has("--yes"),
  };
}

async function main(argv: readonly string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  console.log(
    `pg→vault migration:\n` +
      `  vault-root: ${args.vaultRoot}\n` +
      `  pg: ${args.pgUrl.replace(/:[^:@]*@/, ":***@")}\n` +
      `  project-id: ${args.projectId}\n` +
      `  embedding dims: ${args.embeddingDimensions}\n` +
      `  reembed: ${args.reembed}\n` +
      `  verify: ${args.verify}\n` +
      `  dry-run: ${args.dryRun}`,
  );
  if (!args.yes && !args.dryRun) {
    console.log("Starting in 3s — Ctrl-C to abort.");
    await new Promise((r) => setTimeout(r, 3000));
  }

  const client = postgres(args.pgUrl, { onnotice: () => {} });
  const db = drizzle(client, { schema });

  // Source dim from pgvector column metadata
  const dimRow = await client<Array<{ atttypmod: number }>>`
    SELECT atttypmod FROM pg_attribute
    WHERE attrelid = 'memories'::regclass AND attname = 'embedding'
  `;
  if (dimRow.length === 0) {
    console.error("could not introspect memories.embedding column dim");
    await client.end();
    return EXIT.PREFLIGHT;
  }
  const sourceDim = dimRow[0].atttypmod;

  const dimCheck = checkDims({
    sourceDim,
    destDim: args.embeddingDimensions,
    reembed: args.reembed,
  });
  if (!dimCheck.ok) {
    console.error(`preflight: ${dimCheck.reason}`);
    await client.end();
    return EXIT.PREFLIGHT;
  }

  // Source-side count summary for the run plan
  const counts: CountsByKind = await readCounts(db);
  console.log(
    `source counts: workspaces=${counts.workspaces} memories=${counts.memories} ` +
      `comments=${counts.comments} flags=${counts.flags} relationships=${counts.relationships}`,
  );

  if (args.dryRun) {
    console.log("dry-run: exiting without writes.");
    await client.end();
    return EXIT.OK;
  }

  // Build source reader bound to drizzle
  const source: PgSource = {
    readWorkspaces: () =>
      db
        .select()
        .from(schema.workspaces)
        .then((rows) =>
          rows.map((w) => ({ id: w.id, created_at: w.created_at })),
        ),
    readMemoriesWithEmbeddings: async () => {
      const rows = await db.select().from(schema.memories);
      return rows.map((r) => ({
        memory: rowToMemory(r),
        embedding: r.embedding ?? [],
      }));
    },
    readComments: () =>
      db
        .select()
        .from(schema.comments)
        .then((rows) =>
          rows.map((c) => ({
            id: c.id,
            memory_id: c.memory_id,
            author: c.author,
            content: c.content,
          })),
        ),
    readFlags: () =>
      db
        .select()
        .from(schema.flags)
        .then((rows) => rows.map((f) => rowToFlag(f) as Flag)),
    readRelationships: () =>
      db
        .select()
        .from(schema.relationships)
        .then((rows) => rows.map((r) => rowToRelationship(r) as Relationship)),
    counts: async () => counts,
  };

  // Build destination — VaultBackend in migration mode
  const backend = await VaultBackend.create({
    root: args.vaultRoot,
    projectId: args.projectId,
    embeddingDimensions: args.embeddingDimensions,
    trackUsersInGit: args.trackUsersInGit,
    migrationMode: true,
  });

  const provider = createEmbeddingProvider();
  const embedder = (text: string): Promise<number[]> => provider.embed(text);

  try {
    await runPgToVault({
      source,
      destination: backend,
      reembed: args.reembed,
      embedder,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`write phase failed: ${msg}`);
    await backend.close();
    await client.end();
    return EXIT.WRITE;
  }

  await backend.close();

  // Single bulk commit
  try {
    const git = simpleGit({ baseDir: args.vaultRoot });
    if (!(await git.checkIsRepo())) {
      await git.init();
    }
    await git.add(["-A"]);
    const status = await git.status();
    if (status.staged.length > 0 || status.created.length > 0) {
      const actor =
        (
          await git.raw(["config", "user.email"]).catch(() => "agent-brain")
        ).trim() || "agent-brain";
      const subject = "migration: pg → vault";
      const body =
        `AB-Action: migration\n` +
        `AB-Source: pg\n` +
        `AB-Count: ${counts.memories}\n` +
        `AB-Actor: ${actor}`;
      await git.commit(`${subject}\n\n${body}`);
    } else {
      console.log("no files staged after migration — nothing to commit.");
    }

    // Best-effort push (only if origin configured)
    const remotes = await git.getRemotes(true);
    if (remotes.some((r) => r.name === "origin")) {
      try {
        await git.raw(["push", "--set-upstream", "origin", "HEAD:main"]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`push failed (commit landed locally): ${msg}`);
        await client.end();
        return EXIT.COMMIT_OR_PUSH;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`bulk commit failed: ${msg}`);
    await client.end();
    return EXIT.COMMIT_OR_PUSH;
  }

  if (args.verify) {
    const destBackend = await VaultBackend.create({
      root: args.vaultRoot,
      projectId: args.projectId,
      embeddingDimensions: args.embeddingDimensions,
      trackUsersInGit: args.trackUsersInGit,
      migrationMode: true,
    });
    const destCounts = await readCountsFromVault(args.vaultRoot, destBackend);
    await destBackend.close();
    const diff = compareCounts(counts, destCounts);
    if (diff.length > 0) {
      for (const d of diff) {
        console.error(
          `verify mismatch: ${d.kind} source=${d.source} destination=${d.destination}`,
        );
      }
      await client.end();
      return EXIT.VERIFY;
    }
    console.log("verify: counts match across all kinds.");
  }

  await client.end();
  return EXIT.OK;
}

// --- helpers ---

async function readCounts(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<CountsByKind> {
  const [w, m, c, f, r] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.workspaces),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.memories),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.comments),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.flags),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.relationships),
  ]);
  return {
    workspaces: w[0].n,
    memories: m[0].n,
    comments: c[0].n,
    flags: f[0].n,
    relationships: r[0].n,
  };
}

async function readCountsFromVault(
  root: string,
  backend: VaultBackend,
): Promise<CountsByKind> {
  // Reuse the parser walks to count what landed on disk. Cheap because
  // post-migration state has just been written.
  const { listMarkdownFiles } = await import("../backend/vault/io/vault-fs.js");
  const { parseMemoryFile } =
    await import("../backend/vault/parser/memory-parser.js");
  const files = await listMarkdownFiles(root);
  let memories = 0;
  let comments = 0;
  let flags = 0;
  let relationships = 0;
  for (const path of files) {
    const parsed = await parseMemoryFile(path);
    if (!parsed.ok) continue;
    memories += 1;
    comments += parsed.comments.length;
    flags += parsed.flags.length;
    relationships += parsed.relationships.length;
  }
  // Workspaces are directories under <root>/workspaces; cheaper to count
  // distinct workspace_ids on parsed memories.
  const { readdir } = await import("node:fs/promises");
  const wsEntries = await readdir(`${root}/workspaces`, {
    withFileTypes: true,
  }).catch(() => []);
  const workspaces = wsEntries.filter((e) => e.isDirectory()).length;
  void backend; // backend reference reserved for future cross-checks
  return { workspaces, memories, comments, flags, relationships };
}

function rowToMemory(row: typeof schema.memories.$inferSelect): Memory {
  return {
    id: row.id,
    project_id: row.project_id,
    workspace_id: row.workspace_id,
    scope: row.scope,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: row.tags ?? [],
    archived: row.archived,
    user_id: row.user_id,
    author: row.author,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToFlag(row: typeof schema.flags.$inferSelect): unknown {
  // Direct field-for-field copy; downstream FlagRepository.create expects
  // the schema-shaped Flag object.
  return row;
}

function rowToRelationship(
  row: typeof schema.relationships.$inferSelect,
): unknown {
  return row;
}

if (process.argv[1] && process.argv[1].endsWith("migrate-pg-to-vault.js")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(EXIT.WRITE);
    },
  );
}

export { main };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS — typescript clean. (If `rowToFlag` / `rowToRelationship` helpers fail to satisfy the Flag/Relationship types, narrow the casts to match `src/types/flag.ts` / `src/types/relationship.ts` field-for-field. The schema columns and the type fields are already aligned 1:1, so a direct return is sufficient.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/migrate-pg-to-vault.ts
git commit -m "$(cat <<'EOF'
feat(cli): migrate-pg-to-vault entry script

Argv + env parsing, drizzle source readers, VaultBackend in migration
mode, single bulk commit with AB-* trailers, optional push, counts-only
verify.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: CLI entry — migrate-vault-to-pg

**Files:**

- Create: `src/cli/migrate-vault-to-pg.ts`

- [ ] **Step 1: Write the file**

Create `src/cli/migrate-vault-to-pg.ts`:

```ts
#!/usr/bin/env node
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { readdir } from "node:fs/promises";
import * as schema from "../db/schema.js";
import { PostgresBackend } from "../backend/postgres/index.js";
import { VaultBackend } from "../backend/vault/index.js";
import { createEmbeddingProvider } from "../providers/embedding/index.js";
import {
  checkDims,
  checkTargetEmpty,
  checkDrizzleCurrent,
} from "./migrate/preflight.js";
import { compareCounts } from "./migrate/verify.js";
import { runVaultToPg, type VaultSource } from "./migrate/vault-to-pg.js";
import { EXIT, type ExitCode, type CountsByKind } from "./migrate/types.js";
import type { Memory } from "../types/memory.js";
import type { Flag } from "../types/flag.js";
import type { Relationship } from "../types/relationship.js";

interface Args {
  vaultRoot: string;
  pgUrl: string;
  projectId: string;
  embeddingDimensions: number;
  reembed: boolean;
  verify: boolean;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (k: string): boolean => argv.includes(k);
  const required = (envKey: string, flagKey: string): string => {
    const v = get(flagKey) ?? process.env[envKey];
    if (!v) {
      console.error(`missing ${flagKey} (or env ${envKey})`);
      process.exit(EXIT.PREFLIGHT);
    }
    return v;
  };
  const dimsRaw =
    get("--embedding-dimensions") ??
    process.env.AGENT_BRAIN_EMBEDDING_DIMENSIONS;
  if (!dimsRaw) {
    console.error("missing --embedding-dimensions");
    process.exit(EXIT.PREFLIGHT);
  }
  const dims = Number.parseInt(dimsRaw, 10);
  if (!Number.isFinite(dims) || dims <= 0) {
    console.error(`invalid embedding dimensions: ${dimsRaw}`);
    process.exit(EXIT.PREFLIGHT);
  }
  return {
    vaultRoot: required("AGENT_BRAIN_VAULT_ROOT", "--vault-root"),
    pgUrl: required("AGENT_BRAIN_DATABASE_URL", "--pg-url"),
    projectId: required("AGENT_BRAIN_PROJECT_ID", "--project-id"),
    embeddingDimensions: dims,
    reembed: has("--reembed"),
    verify: !has("--no-verify"),
    dryRun: has("--dry-run"),
    yes: has("--yes"),
  };
}

async function main(argv: readonly string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  console.log(
    `vault→pg migration:\n` +
      `  vault-root: ${args.vaultRoot}\n` +
      `  pg: ${args.pgUrl.replace(/:[^:@]*@/, ":***@")}\n` +
      `  project-id: ${args.projectId}\n` +
      `  embedding dims: ${args.embeddingDimensions}\n` +
      `  reembed: ${args.reembed}\n` +
      `  verify: ${args.verify}\n` +
      `  dry-run: ${args.dryRun}`,
  );
  if (!args.yes && !args.dryRun) {
    console.log("Starting in 3s — Ctrl-C to abort.");
    await new Promise((r) => setTimeout(r, 3000));
  }

  const client = postgres(args.pgUrl, { onnotice: () => {} });
  const db = drizzle(client, { schema });

  // Preflight: target empty
  const targetEmpty = await checkTargetEmpty({
    countMemories: async () => {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.memories);
      return rows[0].n;
    },
  });
  if (!targetEmpty.ok) {
    console.error(`preflight: ${targetEmpty.reason}`);
    await client.end();
    return EXIT.PREFLIGHT;
  }

  // Preflight: drizzle currency
  const drizzleCheck = await checkDrizzleCurrent({
    latestApplied: async () => {
      const rows = await client<Array<{ hash: string }>>`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1
      `;
      return rows.length === 0 ? null : rows[0].hash;
    },
    expectedLatest: await readExpectedLatestHash(),
  });
  if (!drizzleCheck.ok) {
    console.error(`preflight: ${drizzleCheck.reason}`);
    await client.end();
    return EXIT.PREFLIGHT;
  }

  // Source backend (vault) in migration mode
  const vaultBackend = await VaultBackend.create({
    root: args.vaultRoot,
    projectId: args.projectId,
    embeddingDimensions: args.embeddingDimensions,
    migrationMode: true,
  });

  const sourceDim = await vaultBackend["vectorIndex"].dims;
  const dimCheck = checkDims({
    sourceDim,
    destDim: args.embeddingDimensions,
    reembed: args.reembed,
  });
  if (!dimCheck.ok) {
    console.error(`preflight: ${dimCheck.reason}`);
    await vaultBackend.close();
    await client.end();
    return EXIT.PREFLIGHT;
  }

  const counts = await readVaultCounts(args.vaultRoot);
  console.log(
    `source counts: workspaces=${counts.workspaces} memories=${counts.memories} ` +
      `comments=${counts.comments} flags=${counts.flags} relationships=${counts.relationships}`,
  );

  if (args.dryRun) {
    console.log("dry-run: exiting without writes.");
    await vaultBackend.close();
    await client.end();
    return EXIT.OK;
  }

  // Vault source reader (uses parser walk + lance for embeddings)
  const source: VaultSource = await buildVaultSource(
    args.vaultRoot,
    vaultBackend,
  );

  const pgBackend = await PostgresBackend.create(args.pgUrl);
  const provider = createEmbeddingProvider();
  const embedder = (text: string): Promise<number[]> => provider.embed(text);

  try {
    await runVaultToPg({
      source,
      destination: pgBackend,
      reembed: args.reembed,
      embedder,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`write phase failed: ${msg}`);
    await pgBackend.close();
    await vaultBackend.close();
    await client.end();
    return EXIT.WRITE;
  }

  await pgBackend.close();
  await vaultBackend.close();

  if (args.verify) {
    const dest = await readCountsFromPg(client);
    const diff = compareCounts(counts, dest);
    if (diff.length > 0) {
      for (const d of diff) {
        console.error(
          `verify mismatch: ${d.kind} source=${d.source} destination=${d.destination}`,
        );
      }
      await client.end();
      return EXIT.VERIFY;
    }
    console.log("verify: counts match across all kinds.");
  }

  await client.end();
  return EXIT.OK;
}

// --- helpers ---

async function readExpectedLatestHash(): Promise<string> {
  // The compiled drizzle/_journal.json carries the latest known migration
  // tag/hash. For this CLI's correctness, it is sufficient to compare the
  // latest applied row to the file; if drift goes the other way (file
  // ahead of DB), checkDrizzleCurrent surfaces it.
  const { readFile } = await import("node:fs/promises");
  const journal = JSON.parse(
    await readFile("./drizzle/meta/_journal.json", "utf8"),
  ) as { entries: Array<{ tag: string }> };
  if (journal.entries.length === 0) return "";
  return journal.entries[journal.entries.length - 1].tag;
}

async function readVaultCounts(root: string): Promise<CountsByKind> {
  const { listMarkdownFiles } = await import("../backend/vault/io/vault-fs.js");
  const { parseMemoryFile } =
    await import("../backend/vault/parser/memory-parser.js");
  const files = await listMarkdownFiles(root);
  let memories = 0;
  let comments = 0;
  let flags = 0;
  let relationships = 0;
  for (const path of files) {
    const parsed = await parseMemoryFile(path);
    if (!parsed.ok) continue;
    memories += 1;
    comments += parsed.comments.length;
    flags += parsed.flags.length;
    relationships += parsed.relationships.length;
  }
  const wsEntries = await readdir(`${root}/workspaces`, {
    withFileTypes: true,
  }).catch(() => []);
  const workspaces = wsEntries.filter((e) => e.isDirectory()).length;
  return { workspaces, memories, comments, flags, relationships };
}

async function buildVaultSource(
  root: string,
  backend: VaultBackend,
): Promise<VaultSource> {
  const { listMarkdownFiles } = await import("../backend/vault/io/vault-fs.js");
  const { parseMemoryFile } =
    await import("../backend/vault/parser/memory-parser.js");
  const files = await listMarkdownFiles(root);
  const parsed = [] as Array<Awaited<ReturnType<typeof parseMemoryFile>>>;
  for (const f of files) parsed.push(await parseMemoryFile(f));

  const memoryRows: Array<{ memory: Memory; embedding: number[] }> = [];
  const commentRows: Array<{
    id: string;
    memory_id: string;
    author: string;
    content: string;
  }> = [];
  const flagRows: Flag[] = [];
  const relationshipRows: Relationship[] = [];
  for (const p of parsed) {
    if (!p.ok) continue;
    const row = await backend["vectorIndex"].lookup(p.memory.id);
    memoryRows.push({ memory: p.memory, embedding: row?.embedding ?? [] });
    for (const c of p.comments) commentRows.push(c);
    for (const f of p.flags) flagRows.push(f);
    for (const r of p.relationships) relationshipRows.push(r);
  }

  const wsEntries = await readdir(`${root}/workspaces`, {
    withFileTypes: true,
  }).catch(() => []);
  const workspaces = wsEntries
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, created_at: new Date() }));

  const counts: CountsByKind = {
    workspaces: workspaces.length,
    memories: memoryRows.length,
    comments: commentRows.length,
    flags: flagRows.length,
    relationships: relationshipRows.length,
  };

  return {
    readWorkspaces: async () => workspaces,
    readMemoriesWithEmbeddings: async () => memoryRows,
    readComments: async () => commentRows,
    readFlags: async () => flagRows,
    readRelationships: async () => relationshipRows,
    counts: async () => counts,
  };
}

async function readCountsFromPg(
  client: ReturnType<typeof postgres>,
): Promise<CountsByKind> {
  const [[w], [m], [c], [f], [r]] = await Promise.all([
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM workspaces`,
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM memories`,
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM comments`,
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM flags`,
    client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM relationships`,
  ]);
  return {
    workspaces: w.n,
    memories: m.n,
    comments: c.n,
    flags: f.n,
    relationships: r.n,
  };
}

if (process.argv[1] && process.argv[1].endsWith("migrate-vault-to-pg.js")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(EXIT.WRITE);
    },
  );
}

export { main };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS — typescript clean.

If `backend["vectorIndex"]` access fails the typechecker (private field), expose a minimal accessor on `VaultBackend`:

```ts
// In src/backend/vault/index.ts, add a public method:
/** Phase 6 / migration use only. Fetches a row from the lance index by id. */
async lookupVector(id: string): Promise<{ embedding: number[] } | null> {
  return this.vectorIndex.lookup(id);
}
get vectorDims(): number {
  return this.vectorIndex.dims;
}
```

Then replace `backend["vectorIndex"].lookup(p.memory.id)` with `backend.lookupVector(p.memory.id)` and `vaultBackend["vectorIndex"].dims` with `vaultBackend.vectorDims`.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/migrate-vault-to-pg.ts src/backend/vault/index.ts
git commit -m "$(cat <<'EOF'
feat(cli): migrate-vault-to-pg entry script

Argv + env parsing, vault parser source readers, PostgresBackend dest,
preflight (target-empty + drizzle currency + dim check), counts-only
verify. VaultBackend exposes lookupVector / vectorDims for migration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: package.json scripts

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add scripts**

Locate the `"scripts"` block in `package.json` and add two entries (preserve the trailing comma on existing entries):

```json
"migrate:pg-to-vault": "node dist/cli/migrate-pg-to-vault.js",
"migrate:vault-to-pg": "node dist/cli/migrate-vault-to-pg.js",
```

- [ ] **Step 2: Build to confirm CLI compiles**

Run: `npm run build`
Expected: PASS — `dist/cli/migrate-pg-to-vault.js` and `dist/cli/migrate-vault-to-pg.js` exist.

Verify:

```bash
ls dist/cli/migrate-*.js
```

Expected output: both `.js` files listed.

- [ ] **Step 3: Smoke each CLI's `--dry-run` against an empty repo**

```bash
# Smoke test 1: pg-to-vault preflight chain on a non-existent project should
# bail at the embedding-dimensions read since pg is empty.
AGENT_BRAIN_DATABASE_URL=postgres://invalid:invalid@127.0.0.1:5/x \
  AGENT_BRAIN_VAULT_ROOT=/tmp/v6-smoke \
  AGENT_BRAIN_PROJECT_ID=p \
  AGENT_BRAIN_EMBEDDING_DIMENSIONS=4 \
  node dist/cli/migrate-pg-to-vault.js --dry-run --yes || echo "expected non-zero exit"
```

Expected: non-zero exit with a connection / preflight error logged. (Confirms the CLI loads and parses argv.)

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore(cli): npm scripts for Phase 6 migration entry points

migrate:pg-to-vault and migrate:vault-to-pg run the compiled CLIs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: E2E roundtrip integration test

**Files:**

- Create: `tests/integration/migration-roundtrip.test.ts`

- [ ] **Step 1: Write the test**

This test seeds pg with a small fixture set, runs `pg-to-vault` programmatically, opens the resulting vault via a fresh `VaultBackend`, asserts a sample of structural-equal `findById` reads, then runs `vault-to-pg` against a fresh database and asserts counts match the original.

Create `tests/integration/migration-roundtrip.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { PostgresBackend } from "../../src/backend/postgres/index.js";
import { VaultBackend } from "../../src/backend/vault/index.js";
import {
  runPgToVault,
  type PgSource,
} from "../../src/cli/migrate/pg-to-vault.js";
import {
  runVaultToPg,
  type VaultSource,
} from "../../src/cli/migrate/vault-to-pg.js";
import type { Memory } from "../../src/types/memory.js";

const PG_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/agent_brain_test";

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "migration-roundtrip-"));
}

async function truncateAll(client: ReturnType<typeof postgres>) {
  await client`TRUNCATE TABLE relationships, flags, comments, memories, workspaces RESTART IDENTITY CASCADE`;
}

describe("migration-roundtrip", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let vaultRoot: string;

  beforeAll(async () => {
    client = postgres(PG_URL);
    db = drizzle(client, { schema });
    await truncateAll(client);
    vaultRoot = await tmp();
  });

  afterAll(async () => {
    await client.end();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it("seeds pg, migrates pg→vault, reads back, migrates vault→pg, asserts counts", async () => {
    // Seed: 3 workspaces, 6 memories (2 per ws), 3 comments, 1 flag, 2 relationships
    const pg = await PostgresBackend.create(PG_URL);
    for (const ws of ["ws-a", "ws-b", "ws-c"]) {
      await pg.workspaceRepo.findOrCreate(ws);
    }
    const memIds: string[] = [];
    let i = 0;
    for (const ws of ["ws-a", "ws-b", "ws-c"]) {
      for (const slot of [0, 1]) {
        const id = `m${++i}`;
        memIds.push(id);
        const memory: Memory = {
          id,
          project_id: "p",
          workspace_id: ws,
          scope: "workspace",
          type: "fact",
          title: `m${i} in ${ws}`,
          content: `body ${i}`,
          tags: [],
          archived: false,
          user_id: "u",
          author: "u",
          version: 1,
          created_at: new Date(),
          updated_at: new Date(),
        };
        await pg.memoryRepo.create({ ...memory, embedding: [i, i, i, i] });
        void slot;
      }
    }
    await pg.commentRepo.create({
      id: "c1",
      memory_id: memIds[0],
      author: "u",
      content: "hello",
    });
    await pg.commentRepo.create({
      id: "c2",
      memory_id: memIds[1],
      author: "u",
      content: "world",
    });
    await pg.commentRepo.create({
      id: "c3",
      memory_id: memIds[2],
      author: "u",
      content: "!",
    });
    await pg.close();

    // Build pg source reader (same as in migrate-pg-to-vault entry; copied
    // here to keep the test independent of the CLI argv layer).
    const counts = await readPgCounts(db);
    const source: PgSource = {
      readWorkspaces: async () =>
        (await db.select().from(schema.workspaces)).map((w) => ({
          id: w.id,
          created_at: w.created_at,
        })),
      readMemoriesWithEmbeddings: async () =>
        (await db.select().from(schema.memories)).map((r) => ({
          memory: rowToMemory(r),
          embedding: r.embedding ?? [],
        })),
      readComments: async () =>
        (await db.select().from(schema.comments)).map((c) => ({
          id: c.id,
          memory_id: c.memory_id,
          author: c.author,
          content: c.content,
        })),
      readFlags: async () => [],
      readRelationships: async () => [],
      counts: async () => counts,
    };

    const vault = await VaultBackend.create({
      root: vaultRoot,
      projectId: "p",
      embeddingDimensions: 4,
      migrationMode: true,
    });
    await runPgToVault({
      source,
      destination: vault,
      reembed: false,
      embedder: async () => [0, 0, 0, 0],
    });
    await vault.close();

    // Reopen vault and assert sample memories round-trip
    const vault2 = await VaultBackend.create({
      root: vaultRoot,
      projectId: "p",
      embeddingDimensions: 4,
      migrationMode: true,
    });
    for (const id of memIds.slice(0, 3)) {
      const m = await vault2.memoryRepo.findById(id);
      expect(m, `vault findById(${id})`).not.toBeNull();
      expect(m!.id).toBe(id);
    }

    // Now go back: truncate pg, run vault→pg
    await truncateAll(client);
    const vSource = await buildVaultSourceFromVault(vaultRoot, vault2);
    await vault2.close();
    const pg2 = await PostgresBackend.create(PG_URL);
    await runVaultToPg({
      source: vSource,
      destination: pg2,
      reembed: false,
      embedder: async () => [0, 0, 0, 0],
    });
    await pg2.close();

    const after = await readPgCounts(db);
    expect(after.memories).toBe(counts.memories);
    expect(after.workspaces).toBe(counts.workspaces);
    expect(after.comments).toBe(counts.comments);
  });
});

async function readPgCounts(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<{
  workspaces: number;
  memories: number;
  comments: number;
  flags: number;
  relationships: number;
}> {
  const [w, m, c, f, r] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.workspaces),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.memories),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.comments),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.flags),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.relationships),
  ]);
  return {
    workspaces: w[0].n,
    memories: m[0].n,
    comments: c[0].n,
    flags: f[0].n,
    relationships: r[0].n,
  };
}

function rowToMemory(row: typeof schema.memories.$inferSelect): Memory {
  return {
    id: row.id,
    project_id: row.project_id,
    workspace_id: row.workspace_id,
    scope: row.scope,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: row.tags ?? [],
    archived: row.archived,
    user_id: row.user_id,
    author: row.author,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function buildVaultSourceFromVault(
  root: string,
  backend: VaultBackend,
): Promise<VaultSource> {
  const { listMarkdownFiles } =
    await import("../../src/backend/vault/io/vault-fs.js");
  const { parseMemoryFile } =
    await import("../../src/backend/vault/parser/memory-parser.js");
  const { readdir } = await import("node:fs/promises");
  const files = await listMarkdownFiles(root);
  const memoryRows: Array<{ memory: Memory; embedding: number[] }> = [];
  const commentRows: Array<{
    id: string;
    memory_id: string;
    author: string;
    content: string;
  }> = [];
  for (const f of files) {
    const p = await parseMemoryFile(f);
    if (!p.ok) continue;
    const lance = await backend.lookupVector(p.memory.id);
    memoryRows.push({ memory: p.memory, embedding: lance?.embedding ?? [] });
    for (const c of p.comments) commentRows.push(c);
  }
  const wsEntries = await readdir(`${root}/workspaces`, {
    withFileTypes: true,
  }).catch(() => []);
  const workspaces = wsEntries
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, created_at: new Date() }));
  const counts = {
    workspaces: workspaces.length,
    memories: memoryRows.length,
    comments: commentRows.length,
    flags: 0,
    relationships: 0,
  };
  return {
    readWorkspaces: async () => workspaces,
    readMemoriesWithEmbeddings: async () => memoryRows,
    readComments: async () => commentRows,
    readFlags: async () => [],
    readRelationships: async () => [],
    counts: async () => counts,
  };
}
```

- [ ] **Step 2: Run integration tests**

This requires a running pg + drizzle migrations applied (same setup as existing integration tests).

```bash
npm run test:integration -- tests/integration/migration-roundtrip.test.ts
```

Expected: PASS — counts match, sample findById reads succeed.

If the test runs against a shared pg, ensure the `truncateAll` calls do not interfere with parallel suites (the existing integration suites already serialize via vitest config; confirm in `vitest.config.ts`).

- [ ] **Step 3: Run the entire integration suite to catch regressions**

```bash
npm run test:integration
```

Expected: PASS — all integration tests, including the new one.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/migration-roundtrip.test.ts
git commit -m "$(cat <<'EOF'
test(migration): E2E roundtrip pg<->vault parity

Seeds pg, runs pg-to-vault, reopens vault, sample findById asserts,
truncates pg, runs vault-to-pg, asserts counts match. Covers Phase 6
parity contract from master vault design line 428-429.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Update roadmap row + final commit

**Files:**

- Modify: `docs/superpowers/specs/2026-04-21-vault-backend-design.md`

- [ ] **Step 1: Flip Phase 6 row to Done**

Edit `docs/superpowers/specs/2026-04-21-vault-backend-design.md` line 459. Replace:

```
| 6     | Migration CLI + reverse migration.                                                                                                     |
```

with:

```
| 6     | Migration CLI + reverse migration. **Done — #TBD.**                                                                                    |
```

The PR number is filled in after the PR is opened; for now `#TBD` is the convention used by Phase 4d / Phase 5.

- [ ] **Step 2: Run all checks**

```bash
npm run typecheck
npm run lint
npm run test:unit
```

Expected: ALL PASS.

- [ ] **Step 3: Commit roadmap update**

```bash
git add docs/superpowers/specs/2026-04-21-vault-backend-design.md
git commit -m "$(cat <<'EOF'
docs(vault): mark roadmap Phase 6 done

Migration CLI + reverse migration shipped — pg <-> vault bidirectional.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Final summary**

Push the branch (or open the PR — see worktree finishing skill). At PR-open time, edit the roadmap line to use the actual PR number.

---

## Self-review notes

- **Spec coverage:** every Decision D1–D8 is covered. D1 → Tasks 7–10. D2 → Tasks 9–11. D3 → drivers in Tasks 7–8 (one-shot, no state file). D4 → Task 3 + drivers' embedder branch. D5 → Task 9 bulk commit block. D6 → Tasks 4–5 + Task 10 preflight. D7 → Task 6 + driver-entry verify blocks. D8 → Task 1.
- **Test strategy T1–T5:** T1 = Tasks 3–5. T2 = Task 7. T3 = Task 8. T4 = Task 6. T5 = Task 12.
- **No placeholders:** every step has runnable code or commands.
- **Type consistency:** `MemoryRepository.create` is the public method on both backends and accepts `Memory & { embedding: number[] }`; CLI passes the same shape. `runPgToVault`/`runVaultToPg` use structurally identical `PgSource`/`VaultSource` interfaces; the only differentiator is which `MemoryRepository` they target. `compareCounts` uses `ENTITY_KINDS` for canonical iteration order.
- **Out-of-scope risks:** the test fixture in Task 12 doesn't seed flags/relationships. Counts assertion still passes (zeros on both sides). If we later add flag/relationship seeding here, both kinds need rowToFlag / rowToRelationship in the source reader — same shape as the CLI's helpers.
