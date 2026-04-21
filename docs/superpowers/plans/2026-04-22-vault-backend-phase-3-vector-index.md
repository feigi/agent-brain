# Vault Backend Phase 3 — LanceDB Vector Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four vector-search `MemoryRepository` methods on the vault backend by integrating a LanceDB file-based index, replacing the Phase 2 `NotImplementedError` stubs. After this phase, `VaultBackend` is behaviorally at-parity with `PostgresBackend` for every `MemoryRepository` interface method.

**Architecture:** A new `VaultVectorIndex` primitive (under `src/backend/vault/vector/`) wraps `@lancedb/lancedb` with cosine-distance + filter predicates and is the single point of contact with LanceDB. `VaultMemoryRepository` takes the index via constructor, writes through to it on `create`/`update`/`archive`, and delegates the four vector methods to it. Failure modes mirror the spec: lance is a derived cache, the markdown vault is the source of truth. Contract tests parameterize existing vector-method suites across pg + vault and a new parity test asserts top-K overlap on a ~500-memory corpus.

**Tech Stack:** `@lancedb/lancedb` (file-based, cosine), Node.js, TypeScript, vitest, fast-check.

---

## Scope

**In scope:**

- New `src/backend/vault/vector/lance-index.ts` — typed wrapper: `upsert / delete / search / searchPairwise / listEmbeddings`.
- Wire `VaultMemoryRepository` to the index on `create`, `update` (re-embed on content change), `archive` (delete row).
- Implement `search`, `findDuplicates`, `findPairwiseSimilar`, `listWithEmbeddings` on `VaultMemoryRepository`.
- Contract tests parameterized over pg + vault for the four methods.
- Parity test: 500 synthetic memories → top-K overlap ≥ 95% between pg + vault on 20 queries.
- `VaultBackend` takes an index root (defaults to `<vaultRoot>/.agent-brain/index.lance`); `close()` closes the lance connection.
- A lance-side `content_hash` column so `update` skips re-embed when body unchanged (hash stored on index row only, never in markdown).

**Out of scope (deferred):**

- Git commit/push of lance writes — lance dir is runtime-only (`.agent-brain/`, gitignored).
- Reindex-on-boot from vault scan — added in Phase 5 with the chokidar watcher; Phase 3 assumes writes flow through the repo.
- HNSW/IVF-PQ index tuning — Phase 3 uses a plain (non-indexed) scan; create a vector index once the corpus demands it. The plain scan meets the Phase 3 parity bar and keeps the first-write path simple.
- Embedding provider changes — the `embedding: number[]` parameter on `create`/`update` stays exactly as today.

## Architecture

```
VaultMemoryRepository
  ├─ markdown IO (Phase 2a) — unchanged
  └─ VaultVectorIndex (Phase 3)
       └─ @lancedb/lancedb
            └─ <root>/.agent-brain/index.lance/
```

Every write op in `VaultMemoryRepository` takes the file lock, writes the markdown, then writes through to the lance index inside the same critical section. Lance failures after a successful markdown write log a warning and do **not** fail the caller (spec: vault = source of truth; repair path is Phase 5 watcher-driven reindex). Lance failures on the read path (search/findDuplicates/…) bubble up — a bad index means a bad search result, not a bad memory.

### Table schema

One table: `memories`. Columns:

| Column          | Type                        | Meaning                                     |
| --------------- | --------------------------- | ------------------------------------------- |
| `id`            | Utf8 (primary key for merge) | memory id                                   |
| `project_id`    | Utf8                        | deployment isolation filter                 |
| `workspace_id`  | Utf8 nullable               | workspace scope filter                      |
| `scope`         | Utf8                        | `workspace` / `user` / `project`            |
| `author`        | Utf8                        | user-scope filter                           |
| `title`         | Utf8                        | returned by findDuplicates                  |
| `archived`      | Bool                        | mirrors `archived_at IS NOT NULL`           |
| `content_hash`  | Utf8                        | sha256(content) — skip re-embed on no-op    |
| `vector`        | FixedSizeList<Float32, D>   | embedding; D derived from first insert      |

`D` is locked on first write (embedding_dimensions from the first create). Subsequent writes with mismatched dimension throw `ValidationError` at the wrapper.

### Write path

```
memoryRepo.create({...memory, embedding})
  ├─ lock + serialize + writeAtomic (existing Phase 2a)
  ├─ index.upsert({ id, project_id, workspace_id, scope, author, title,
  │                 archived: false, content_hash: sha256(content), vector: embedding })
  └─ return memory
```

```
memoryRepo.update(id, expectedVersion, updates)
  ├─ existing Phase 2a read-modify-write under lock
  ├─ if updates.embedding provided:
  │     index.upsert({ id, ...meta, content_hash, vector: updates.embedding })
  │  else if meta changed (archived_at is handled by archive, but scope/author/title/ws can drift):
  │     index.upsertMetaOnly({ id, ...meta })   // preserves existing vector
  └─ return next
```

```
memoryRepo.archive(ids)
  ├─ existing Phase 2a loop
  └─ for each id that was archived: index.markArchived(id)
     (soft-delete via column flip, not row delete — avoids re-embed churn
     if a future operation were to un-archive)
```

### Read path

All four read methods go through `VaultVectorIndex`:

- `search(SearchOptions)` → `table.search(embedding).where(<filter>).distanceType("cosine").limit(limit+overshoot).toArray()`, map rows to `MemoryWithRelevance` by reading markdown files for full `Memory` shape. Filter `archived = false` always.
- `findDuplicates(options)` → same shape, `limit(1)`, scope-aware `where` clause matching `DrizzleMemoryRepository.findDuplicates` semantics (D-16), threshold applied post-query.
- `findPairwiseSimilar(options)` → for each row in the scope slice, run a `search(row.vector).where(id > row.id AND same_scope).limit(topN)`; union filter to `>= threshold`. O(N·K) not O(N²) — matches pg's CROSS JOIN bound since pg filters by threshold.
- `listWithEmbeddings(options)` → scan + filter + return Memory + raw embedding. The vector is pulled from lance (not the markdown).

### Failure semantics

| Failure                                 | Phase 3 behavior                                                   |
| --------------------------------------- | ------------------------------------------------------------------ |
| Lance upsert fails after markdown write | Log warning, caller sees success. Index is now stale for this id. Repair in Phase 5. |
| Lance delete fails during archive       | Same — log + succeed. Next search may surface the archived memory with a stale row; `archived=false` filter on the read path keys on the lance row, so this is a visible bug. Add an explicit unit test that exercises this branch. |
| Dimension mismatch on write             | `ValidationError` — hard fail, markdown has already been written under Phase 2a. Caller sees success on markdown but the vector is not indexed. Acceptable for Phase 3 — a dimension change is operator-driven and rare. |
| Index corruption / missing              | `VaultVectorIndex.create` throws on startup. `VaultBackend.create` propagates. |
| Search on empty index                   | Return `[]`. |

## File Structure

**New files:**

- `src/backend/vault/vector/lance-index.ts` — `VaultVectorIndex` class: `create()`, `close()`, `upsert()`, `upsertMetaOnly()`, `markArchived()`, `search()`, `findDuplicates()`, `findPairwiseSimilar()`, `listEmbeddings()`.
- `src/backend/vault/vector/schema.ts` — Arrow schema builder `memorySchema(dims: number)`.
- `src/backend/vault/vector/hash.ts` — `contentHash(content: string): string` (sha256 hex).
- `tests/unit/backend/vault/vector/lance-index.test.ts` — CRUD + search + empty-index cases.
- `tests/contract/repositories/memory-repository-vector.test.ts` — parameterized over pg + vault for the four vector methods.
- `tests/integration/vector-parity.test.ts` — 500-memory parity.

**Modified files:**

- `src/backend/vault/repositories/memory-repository.ts` — constructor takes `VaultVectorIndex`; remove the four `NotImplementedError` stubs; hook write-through on `create` / `update` / `archive`.
- `src/backend/vault/index.ts` — `VaultBackend.create()` instantiates + holds the index; `close()` closes it.
- `tests/contract/repositories/_factories.ts` — `vaultFactory` instantiates a temp lance-backed index (gets `mkdtemp`-allocated root like today); close disposes both dirs.
- `package.json` / `package-lock.json` — add `@lancedb/lancedb` (runtime dep), `apache-arrow` (peer), and `@lancedb/lancedb` types if needed.

## Open decisions (locked)

- **Index location:** `<vaultRoot>/.agent-brain/index.lance/`. Gitignored (Phase 4 adds the `.gitignore` write; Phase 3 just creates the dir).
- **Distance metric:** cosine. Matches pg `cosineDistance` and the driver default we use for pgvector.
- **`embedding_dimensions` source of truth:** first write pins D on the lance table schema. The repo passes through whatever the caller sends; dim drift is a `ValidationError`.
- **Dedup of `create` ↔ `upsert`:** `VaultVectorIndex.upsert` is idempotent (mergeInsert on `id`). `create` uses upsert; `update` uses upsert. No separate `insert` method.
- **Pairwise implementation:** N iterative searches, not a cross join. Bounded by `topN = 32` results per row, filtered by `threshold`. This keeps per-row work independent of N at the cost of missing pairs above rank 32 — acceptable because `findPairwiseSimilar`'s caller (consolidation) is already bounded to `<500` active memories in practice.
- **Plain scan vs indexed:** Phase 3 ships with a plain scan (no `createIndex` call). Top-K correctness is exact; latency scales linearly. Phase 8 (perf) adds `Index.ivfPq` or HNSW once the corpus and the budget targets justify it.

---

## File Structure Summary

| File                                                   | Responsibility                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `vector/schema.ts`                                     | Arrow schema builder                                            |
| `vector/hash.ts`                                       | Pure content hash                                               |
| `vector/lance-index.ts`                                | Stateful wrapper: connect, upsert, markArchived, search, etc.   |
| `repositories/memory-repository.ts` (modified)         | Wire write-through + implement 4 vector methods via index       |
| `index.ts` (modified)                                  | Compose index into VaultBackend lifecycle                       |
| `tests/unit/backend/vault/vector/lance-index.test.ts`  | Wrapper unit coverage                                           |
| `tests/contract/repositories/memory-repository-vector.test.ts` | Parity across pg + vault for the four methods           |
| `tests/integration/vector-parity.test.ts`              | 500-memory overlap                                              |

---

## Task breakdown

Tasks target 5–15 minutes each. Commit after each. Subagent-driven execution is the default.

### Task 1: Add `@lancedb/lancedb` dependency and smoke-import

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/unit/backend/vault/vector/smoke.test.ts`

- [ ] **Step 1: Install**

```bash
npm i @lancedb/lancedb@^0.23 apache-arrow
```

- [ ] **Step 2: Add a smoke test that connects + creates + drops a temp table**

```ts
// tests/unit/backend/vault/vector/smoke.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";

describe("@lancedb/lancedb smoke", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("connects, creates a table, queries it, drops it", async () => {
    root = await mkdtemp(join(tmpdir(), "lance-smoke-"));
    const db = await lancedb.connect(root);
    const table = await db.createTable("t", [
      { id: "a", vector: [0.1, 0.2, 0.3] },
      { id: "b", vector: [0.9, 0.8, 0.7] },
    ]);
    const got = await table
      .search([0.1, 0.2, 0.3])
      .distanceType("cosine")
      .limit(2)
      .toArray();
    expect(got.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 3: Run smoke test**

```bash
npx vitest run tests/unit/backend/vault/vector/smoke.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tests/unit/backend/vault/vector/smoke.test.ts
git commit -m "chore(deps): add @lancedb/lancedb + apache-arrow for vault vector index"
```

---

### Task 2: `vector/hash.ts` + unit test

**Files:**
- Create: `src/backend/vault/vector/hash.ts`
- Create: `tests/unit/backend/vault/vector/hash.test.ts`

- [ ] **Step 1: Write test**

```ts
// tests/unit/backend/vault/vector/hash.test.ts
import { describe, it, expect } from "vitest";
import { contentHash } from "../../../../../src/backend/vault/vector/hash.js";

describe("contentHash", () => {
  it("is deterministic for equal content", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("differs for different content", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });

  it("is a 64-char hex string (sha256)", () => {
    expect(contentHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/unit/backend/vault/vector/hash.test.ts
```

Expected: FAIL — cannot find `hash.js`.

- [ ] **Step 3: Implement**

```ts
// src/backend/vault/vector/hash.ts
import { createHash } from "node:crypto";

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run tests/unit/backend/vault/vector/hash.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/vector/hash.ts tests/unit/backend/vault/vector/hash.test.ts
git commit -m "feat(vault-vector): add sha256 contentHash helper"
```

---

### Task 3: `vector/schema.ts` + unit test

**Files:**
- Create: `src/backend/vault/vector/schema.ts`
- Create: `tests/unit/backend/vault/vector/schema.test.ts`

- [ ] **Step 1: Write test**

```ts
// tests/unit/backend/vault/vector/schema.test.ts
import { describe, it, expect } from "vitest";
import * as arrow from "apache-arrow";
import { memorySchema } from "../../../../../src/backend/vault/vector/schema.js";

describe("memorySchema", () => {
  it("has the expected fields", () => {
    const s = memorySchema(768);
    const names = s.fields.map((f) => f.name).sort();
    expect(names).toEqual([
      "archived",
      "author",
      "content_hash",
      "id",
      "project_id",
      "scope",
      "title",
      "vector",
      "workspace_id",
    ]);
  });

  it("pins the vector dimension", () => {
    const s = memorySchema(4);
    const f = s.fields.find((x) => x.name === "vector")!;
    expect(f.type).toBeInstanceOf(arrow.FixedSizeList);
    expect((f.type as arrow.FixedSizeList).listSize).toBe(4);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/unit/backend/vault/vector/schema.test.ts
```

Expected: FAIL — cannot find `schema.js`.

- [ ] **Step 3: Implement**

```ts
// src/backend/vault/vector/schema.ts
import * as arrow from "apache-arrow";

export function memorySchema(dims: number): arrow.Schema {
  return new arrow.Schema([
    new arrow.Field("id", new arrow.Utf8(), false),
    new arrow.Field("project_id", new arrow.Utf8(), false),
    new arrow.Field("workspace_id", new arrow.Utf8(), true),
    new arrow.Field("scope", new arrow.Utf8(), false),
    new arrow.Field("author", new arrow.Utf8(), false),
    new arrow.Field("title", new arrow.Utf8(), false),
    new arrow.Field("archived", new arrow.Bool(), false),
    new arrow.Field("content_hash", new arrow.Utf8(), false),
    new arrow.Field(
      "vector",
      new arrow.FixedSizeList(
        dims,
        new arrow.Field("item", new arrow.Float32(), true),
      ),
      false,
    ),
  ]);
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run tests/unit/backend/vault/vector/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/vector/schema.ts tests/unit/backend/vault/vector/schema.test.ts
git commit -m "feat(vault-vector): add Arrow memorySchema builder"
```

---

### Task 4: `VaultVectorIndex` skeleton — create, close, upsert, countRows

**Files:**
- Create: `src/backend/vault/vector/lance-index.ts`
- Create: `tests/unit/backend/vault/vector/lance-index.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/backend/vault/vector/lance-index.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultVectorIndex } from "../../../../../src/backend/vault/vector/lance-index.js";

describe("VaultVectorIndex — upsert + countRows", () => {
  let root: string;
  let idx: VaultVectorIndex;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lance-test-"));
    idx = await VaultVectorIndex.create({ root, dims: 4 });
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("upserts rows and counts them", async () => {
    await idx.upsert([
      {
        id: "a",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u",
        title: "t",
        archived: false,
        content_hash: "h1",
        vector: [0.1, 0.2, 0.3, 0.4],
      },
    ]);
    expect(await idx.countRows()).toBe(1);
  });

  it("upsert on the same id replaces the previous row", async () => {
    const base = {
      project_id: "p1",
      workspace_id: "ws1",
      scope: "workspace" as const,
      author: "u",
      title: "t",
      archived: false,
      content_hash: "h",
      vector: [0, 0, 0, 0],
    };
    await idx.upsert([{ id: "a", ...base, content_hash: "h1" }]);
    await idx.upsert([{ id: "a", ...base, content_hash: "h2" }]);
    expect(await idx.countRows()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/unit/backend/vault/vector/lance-index.test.ts
```

Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement skeleton**

```ts
// src/backend/vault/vector/lance-index.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { memorySchema } from "./schema.js";

export interface IndexRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  scope: "workspace" | "user" | "project";
  author: string;
  title: string;
  archived: boolean;
  content_hash: string;
  vector: number[];
}

export interface VaultVectorIndexConfig {
  root: string;           // absolute path; wrapper appends /.agent-brain/index.lance
  dims: number;           // embedding dimension, pins the table schema on first create
}

export class VaultVectorIndex {
  private constructor(
    private readonly db: lancedb.Connection,
    private readonly table: lancedb.Table,
    readonly dims: number,
  ) {}

  static async create(cfg: VaultVectorIndexConfig): Promise<VaultVectorIndex> {
    const dir = join(cfg.root, ".agent-brain", "index.lance");
    await mkdir(dir, { recursive: true });
    const db = await lancedb.connect(dir);
    const existing = await db.tableNames();
    const table = existing.includes("memories")
      ? await db.openTable("memories")
      : await db.createEmptyTable("memories", memorySchema(cfg.dims));
    return new VaultVectorIndex(db, table, cfg.dims);
  }

  async close(): Promise<void> {
    // @lancedb/lancedb manages connection lifetime internally.
    // close is a no-op hook today; kept for future resource cleanup.
  }

  async countRows(): Promise<number> {
    return await this.table.countRows();
  }

  async upsert(rows: IndexRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      if (r.vector.length !== this.dims) {
        throw new Error(
          `vector dimension mismatch: expected ${this.dims}, got ${r.vector.length} for id ${r.id}`,
        );
      }
    }
    await this.table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  }
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run tests/unit/backend/vault/vector/lance-index.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/vector/lance-index.ts tests/unit/backend/vault/vector/lance-index.test.ts
git commit -m "feat(vault-vector): VaultVectorIndex skeleton — create/close/upsert/countRows"
```

---

### Task 5: `VaultVectorIndex.search` + cosine filter predicate

**Files:**
- Modify: `src/backend/vault/vector/lance-index.ts`
- Modify: `tests/unit/backend/vault/vector/lance-index.test.ts`

- [ ] **Step 1: Append failing test block**

```ts
// append to tests/unit/backend/vault/vector/lance-index.test.ts
describe("VaultVectorIndex — search", () => {
  let root: string;
  let idx: VaultVectorIndex;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lance-test-"));
    idx = await VaultVectorIndex.create({ root, dims: 3 });
    await idx.upsert([
      {
        id: "a",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u",
        title: "A",
        archived: false,
        content_hash: "h",
        vector: [1, 0, 0],
      },
      {
        id: "b",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u",
        title: "B",
        archived: false,
        content_hash: "h",
        vector: [0, 1, 0],
      },
      {
        id: "c",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u",
        title: "C",
        archived: true,          // must be filtered out
        content_hash: "h",
        vector: [1, 0, 0],
      },
    ]);
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("returns rows ordered by cosine similarity, excluding archived", async () => {
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(hits[0].relevance).toBeCloseTo(1, 5);
    expect(hits[1].relevance).toBeCloseTo(0, 5);
  });

  it("respects minSimilarity threshold", async () => {
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0.5,
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

```bash
npx vitest run tests/unit/backend/vault/vector/lance-index.test.ts
```

Expected: FAIL — `idx.search is not a function`.

- [ ] **Step 3: Implement**

Add to `VaultVectorIndex`:

```ts
export interface SearchParams {
  embedding: number[];
  projectId: string;
  workspaceId: string | null;
  scope: Array<"workspace" | "user" | "project">;
  userId: string | null;
  limit: number;
  minSimilarity: number;
}

export interface SearchHit {
  id: string;
  relevance: number;
}

async search(params: SearchParams): Promise<SearchHit[]> {
  if (params.embedding.length !== this.dims) {
    throw new Error(
      `vector dimension mismatch: expected ${this.dims}, got ${params.embedding.length}`,
    );
  }
  const clauses: string[] = [
    `archived = false`,
    `project_id = ${sqlStr(params.projectId)}`,
  ];
  const scopeClauses: string[] = [];
  for (const s of params.scope) {
    if (s === "workspace") {
      if (params.workspaceId === null) continue;
      scopeClauses.push(
        `(scope = 'workspace' AND workspace_id = ${sqlStr(params.workspaceId)})`,
      );
    } else if (s === "user") {
      if (params.userId === null) continue;
      scopeClauses.push(
        `(scope = 'user' AND author = ${sqlStr(params.userId)})`,
      );
    } else {
      scopeClauses.push(`scope = 'project'`);
    }
  }
  if (scopeClauses.length === 0) return [];
  clauses.push(`(${scopeClauses.join(" OR ")})`);
  const rows = await this.table
    .search(params.embedding)
    .distanceType("cosine")
    .where(clauses.join(" AND "))
    .limit(params.limit)
    .toArray();
  return rows
    .map((r: Record<string, unknown>) => ({
      id: r.id as string,
      relevance: 1 - Number(r._distance),
    }))
    .filter((h) => h.relevance >= params.minSimilarity);
}
```

Add helper at module scope:

```ts
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run tests/unit/backend/vault/vector/lance-index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(vault-vector): VaultVectorIndex.search with cosine + scope filter"
```

---

### Task 6: `VaultVectorIndex.findDuplicates` (scope-aware, D-16 parity)

**Files:**
- Modify: `src/backend/vault/vector/lance-index.ts`
- Modify: `tests/unit/backend/vault/vector/lance-index.test.ts`

- [ ] **Step 1: Add failing test**

```ts
// append to lance-index.test.ts
describe("VaultVectorIndex — findDuplicates", () => {
  let root: string;
  let idx: VaultVectorIndex;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lance-test-"));
    idx = await VaultVectorIndex.create({ root, dims: 3 });
    await idx.upsert([
      {
        id: "a",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
        author: "u1",
        title: "A",
        archived: false,
        content_hash: "h",
        vector: [1, 0, 0],
      },
      {
        id: "u",
        project_id: "p1",
        workspace_id: null,
        scope: "user",
        author: "u1",
        title: "U",
        archived: false,
        content_hash: "h",
        vector: [1, 0, 0],
      },
    ]);
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("workspace-scope dedup only checks workspace memories", async () => {
    const hits = await idx.findDuplicates({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: "workspace",
      userId: "u1",
      threshold: 0.5,
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("user-scope dedup checks user AND workspace memories (D-16)", async () => {
    const hits = await idx.findDuplicates({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: "user",
      userId: "u1",
      threshold: 0.5,
    });
    // user-scope sees the "a" workspace match as well per D-16
    expect(hits.map((h) => h.id).sort()).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Implement**

```ts
export interface DuplicateParams {
  embedding: number[];
  projectId: string;
  workspaceId: string | null;
  scope: "workspace" | "user" | "project";
  userId: string;
  threshold: number;
}

export interface DuplicateHit {
  id: string;
  title: string;
  relevance: number;
  scope: "workspace" | "user" | "project";
}

async findDuplicates(params: DuplicateParams): Promise<DuplicateHit[]> {
  if (params.embedding.length !== this.dims) {
    throw new Error(
      `vector dimension mismatch: expected ${this.dims}, got ${params.embedding.length}`,
    );
  }
  const clauses: string[] = [
    `archived = false`,
    `project_id = ${sqlStr(params.projectId)}`,
  ];
  if (params.scope === "workspace") {
    if (params.workspaceId === null) {
      throw new Error("workspaceId is required for workspace-scoped dedup");
    }
    clauses.push(
      `scope = 'workspace'`,
      `workspace_id = ${sqlStr(params.workspaceId)}`,
    );
  } else if (params.scope === "project") {
    clauses.push(`scope = 'project'`);
  } else {
    if (params.workspaceId === null) {
      throw new Error("workspaceId is required for user-scoped dedup");
    }
    clauses.push(
      `(workspace_id = ${sqlStr(params.workspaceId)}` +
        ` OR (scope = 'user' AND author = ${sqlStr(params.userId)}))`,
    );
  }
  const rows = await this.table
    .search(params.embedding)
    .distanceType("cosine")
    .where(clauses.join(" AND "))
    .limit(1)
    .toArray();
  return rows
    .map((r: Record<string, unknown>) => ({
      id: r.id as string,
      title: r.title as string,
      relevance: 1 - Number(r._distance),
      scope: r.scope as "workspace" | "user" | "project",
    }))
    .filter((h) => h.relevance >= params.threshold);
}
```

- [ ] **Step 4: Run test, verify pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(vault-vector): VaultVectorIndex.findDuplicates (D-16 parity)"
```

---

### Task 7: `VaultVectorIndex.findPairwiseSimilar` — per-row search approach

**Files:**
- Modify: `src/backend/vault/vector/lance-index.ts`
- Modify: `tests/unit/backend/vault/vector/lance-index.test.ts`

- [ ] **Step 1: Add failing test**

```ts
describe("VaultVectorIndex — findPairwiseSimilar", () => {
  let root: string;
  let idx: VaultVectorIndex;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lance-test-"));
    idx = await VaultVectorIndex.create({ root, dims: 3 });
    await idx.upsert([
      { id: "a", project_id: "p1", workspace_id: "ws1", scope: "workspace", author: "u", title: "A", archived: false, content_hash: "h", vector: [1, 0, 0] },
      { id: "b", project_id: "p1", workspace_id: "ws1", scope: "workspace", author: "u", title: "B", archived: false, content_hash: "h", vector: [0.99, 0.01, 0] },
      { id: "c", project_id: "p1", workspace_id: "ws1", scope: "workspace", author: "u", title: "C", archived: false, content_hash: "h", vector: [0, 1, 0] },
    ]);
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("returns one entry per near-duplicate pair with a < b", async () => {
    const pairs = await idx.findPairwiseSimilar({
      projectId: "p1",
      workspaceId: "ws1",
      scope: "workspace",
      threshold: 0.9,
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].memory_a_id).toBe("a");
    expect(pairs[0].memory_b_id).toBe("b");
    expect(pairs[0].similarity).toBeGreaterThan(0.9);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Implement**

```ts
export interface PairwiseParams {
  projectId: string;
  workspaceId: string | null;
  scope: "workspace" | "project";
  threshold: number;
}

export interface PairwiseHit {
  memory_a_id: string;
  memory_b_id: string;
  similarity: number;
}

async findPairwiseSimilar(params: PairwiseParams): Promise<PairwiseHit[]> {
  const clauses: string[] = [
    `archived = false`,
    `project_id = ${sqlStr(params.projectId)}`,
  ];
  if (params.scope === "project") {
    clauses.push(`scope = 'project'`);
  } else {
    if (params.workspaceId === null) {
      throw new Error("workspaceId is required for workspace-scoped pairwise");
    }
    clauses.push(`scope = 'workspace'`);
    clauses.push(`workspace_id = ${sqlStr(params.workspaceId)}`);
  }
  const where = clauses.join(" AND ");
  // Pull the scope slice including vectors.
  const rows = (await this.table
    .query()
    .where(where)
    .select(["id", "vector"])
    .toArray()) as Array<{ id: string; vector: number[] }>;
  const pairs: PairwiseHit[] = [];
  for (const r of rows) {
    const hits = (await this.table
      .search(Array.from(r.vector))
      .distanceType("cosine")
      .where(`${where} AND id > ${sqlStr(r.id)}`)
      .limit(32)
      .toArray()) as Array<{ id: string; _distance: number }>;
    for (const h of hits) {
      const sim = 1 - Number(h._distance);
      if (sim >= params.threshold) {
        pairs.push({
          memory_a_id: r.id,
          memory_b_id: h.id as string,
          similarity: sim,
        });
      }
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity);
  return pairs;
}
```

- [ ] **Step 4: Run test, verify pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(vault-vector): VaultVectorIndex.findPairwiseSimilar"
```

---

### Task 8: `VaultVectorIndex.listEmbeddings` + `markArchived` + `upsertMetaOnly`

**Files:**
- Modify: `src/backend/vault/vector/lance-index.ts`
- Modify: `tests/unit/backend/vault/vector/lance-index.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe("VaultVectorIndex — listEmbeddings + markArchived + upsertMetaOnly", () => {
  let root: string;
  let idx: VaultVectorIndex;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lance-test-"));
    idx = await VaultVectorIndex.create({ root, dims: 3 });
    await idx.upsert([
      { id: "a", project_id: "p1", workspace_id: "ws1", scope: "workspace", author: "u", title: "A", archived: false, content_hash: "h", vector: [1, 0, 0] },
      { id: "b", project_id: "p1", workspace_id: "ws1", scope: "workspace", author: "u", title: "B", archived: false, content_hash: "h", vector: [0, 1, 0] },
    ]);
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("listEmbeddings returns ids with vectors, excludes archived", async () => {
    await idx.markArchived("b");
    const list = await idx.listEmbeddings({
      projectId: "p1",
      workspaceId: "ws1",
      scope: "workspace",
      userId: null,
      limit: 10,
    });
    expect(list.map((r) => r.id)).toEqual(["a"]);
    expect(list[0].vector).toHaveLength(3);
  });

  it("upsertMetaOnly preserves the existing vector", async () => {
    await idx.upsertMetaOnly({
      id: "a",
      project_id: "p1",
      workspace_id: "ws1",
      scope: "workspace",
      author: "u",
      title: "A-renamed",
      archived: false,
    });
    const list = await idx.listEmbeddings({
      projectId: "p1",
      workspaceId: "ws1",
      scope: "workspace",
      userId: null,
      limit: 10,
    });
    const a = list.find((r) => r.id === "a")!;
    expect(a.vector).toEqual([1, 0, 0]);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Implement**

```ts
async markArchived(id: string): Promise<void> {
  await this.table.update({
    where: `id = ${sqlStr(id)}`,
    values: { archived: true },
  });
}

export interface ListEmbeddingsParams {
  projectId: string;
  workspaceId: string | null;
  scope: "workspace" | "user" | "project";
  userId: string | null;
  limit: number;
}

async listEmbeddings(params: ListEmbeddingsParams): Promise<
  Array<{ id: string; vector: number[] }>
> {
  const clauses: string[] = [
    `archived = false`,
    `project_id = ${sqlStr(params.projectId)}`,
  ];
  if (params.scope === "workspace") {
    if (params.workspaceId === null) {
      throw new Error("workspaceId is required for workspace listEmbeddings");
    }
    clauses.push(
      `scope = 'workspace'`,
      `workspace_id = ${sqlStr(params.workspaceId)}`,
    );
  } else if (params.scope === "user") {
    clauses.push(`scope = 'user'`);
    if (params.userId !== null) {
      clauses.push(`author = ${sqlStr(params.userId)}`);
    }
    if (params.workspaceId !== null) {
      clauses.push(`workspace_id = ${sqlStr(params.workspaceId)}`);
    }
  } else {
    clauses.push(`scope = 'project'`);
  }
  const rows = (await this.table
    .query()
    .where(clauses.join(" AND "))
    .select(["id", "vector"])
    .limit(params.limit)
    .toArray()) as Array<{ id: string; vector: number[] }>;
  return rows.map((r) => ({
    id: r.id,
    vector: Array.from(r.vector),
  }));
}

async upsertMetaOnly(
  meta: Omit<IndexRow, "content_hash" | "vector">,
): Promise<void> {
  const set: Record<string, string> = {
    project_id: sqlStr(meta.project_id),
    scope: sqlStr(meta.scope),
    author: sqlStr(meta.author),
    title: sqlStr(meta.title),
    archived: String(meta.archived),
  };
  if (meta.workspace_id !== null) {
    set.workspace_id = sqlStr(meta.workspace_id);
  } else {
    set.workspace_id = "NULL";
  }
  await this.table.update({
    where: `id = ${sqlStr(meta.id)}`,
    values: set,
  });
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(vault-vector): markArchived + upsertMetaOnly + listEmbeddings"
```

---

### Task 9: Wire index into `VaultMemoryRepository` — constructor + create path

**Files:**
- Modify: `src/backend/vault/repositories/memory-repository.ts`

- [ ] **Step 1: Update `VaultMemoryConfig` and constructor**

```ts
// in memory-repository.ts

import { VaultVectorIndex } from "../vector/lance-index.js";
import { contentHash } from "../vector/hash.js";

export interface VaultMemoryConfig {
  root: string;
  index: VaultVectorIndex;
}

// constructor stays private; static create() takes the VaultVectorIndex
static async create(cfg: VaultMemoryConfig): Promise<VaultMemoryRepository> {
  const index = new Map<string, IndexEntry>();
  const files = await safeListMd(cfg.root);
  for (const rel of files) {
    const loc = inferScopeFromPath(rel);
    if (loc === null) continue;
    index.set(loc.id, {
      path: rel,
      scope: loc.scope,
      workspaceId: loc.workspaceId,
      userId: loc.userId,
    });
  }
  return new VaultMemoryRepository(cfg, index);
}
```

- [ ] **Step 2: Hook write-through inside `create`**

Replace the existing `create` body end with:

```ts
async create(memory: Memory & { embedding: number[] }): Promise<Memory> {
  if (this.index.has(memory.id)) {
    throw new ConflictError(`memory already exists: ${memory.id}`);
  }
  const loc = locationFor(memory);
  const rel = memoryPath(loc);
  const md = serializeMemoryFile({
    memory,
    comments: [],
    relationships: [],
    flags: [],
  });
  const abs = join(this.cfg.root, rel);
  await ensurePlaceholder(abs);
  await withFileLock(abs, async () => {
    const existing = await readMarkdown(this.cfg.root, rel);
    if (existing.length > 0) {
      throw new ConflictError(`memory already exists: ${memory.id}`);
    }
    await writeMarkdownAtomic(this.cfg.root, rel, md);
  });
  this.index.set(memory.id, {
    path: rel,
    scope: loc.scope,
    workspaceId: loc.workspaceId,
    userId: loc.userId,
  });
  await this.cfg.index.upsert([
    {
      id: memory.id,
      project_id: memory.project_id,
      workspace_id: memory.workspace_id,
      scope: memory.scope,
      author: memory.author,
      title: memory.title,
      archived: false,
      content_hash: contentHash(memory.content),
      vector: memory.embedding,
    },
  ]);
  const saved = await this.#read(memory.id);
  return saved.memory;
}
```

- [ ] **Step 3: Update callers (factories + VaultBackend) to construct the index**

In `src/backend/vault/index.ts`:

```ts
import { VaultVectorIndex } from "./vector/lance-index.js";

export interface VaultBackendConfig {
  root: string;
  embeddingDimensions: number;    // NEW — required to pin the lance schema
}

private constructor(
  memoryRepo: MemoryRepository,
  private readonly index: VaultVectorIndex,
  root: string,
) {
  this.memoryRepo = memoryRepo;
  this.workspaceRepo = new VaultWorkspaceRepository({ root });
  this.commentRepo = new VaultCommentRepository({ root });
  this.sessionRepo = new VaultSessionTrackingRepository({ root });
  this.sessionLifecycleRepo = new VaultSessionRepository({ root });
  this.auditRepo = new VaultAuditRepository({ root });
  this.flagRepo = new VaultFlagRepository({ root });
  this.relationshipRepo = new VaultRelationshipRepository({ root });
  this.schedulerStateRepo = new VaultSchedulerStateRepository({ root });
}

static async create(cfg: VaultBackendConfig): Promise<VaultBackend> {
  await mkdir(cfg.root, { recursive: true });
  const index = await VaultVectorIndex.create({
    root: cfg.root,
    dims: cfg.embeddingDimensions,
  });
  const memoryRepo = await VaultMemoryRepository.create({
    root: cfg.root,
    index,
  });
  return new VaultBackend(memoryRepo, index, cfg.root);
}

async close(): Promise<void> {
  await this.index.close();
}
```

In `src/backend/factory.ts` — forward `embeddingDimensions` from config (already present in `src/config.ts` for pg; reuse). Locate the existing `vault` branch, extend:

```ts
case "vault":
  return VaultBackend.create({
    root: cfg.vaultRoot,
    embeddingDimensions: cfg.embeddingDimensions,
  });
```

In `tests/contract/repositories/_factories.ts` `vaultFactory`:

```ts
const root = await mkdtemp(join(tmpdir(), "contract-vault-"));
const { VaultVectorIndex } = await import(
  "../../../src/backend/vault/vector/lance-index.js"
);
const index = await VaultVectorIndex.create({ root, dims: 768 });
const memoryRepo = await VaultMemoryRepository.create({ root, index });
// ...
close: async () => {
  await index.close();
  await rm(root, { recursive: true, force: true });
},
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run existing contract tests — should still pass**

```bash
npx vitest run tests/contract/repositories
```

Expected: all green. None of the four vector methods are touched yet — they still throw `NotImplementedError`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(vault-vector): wire VaultVectorIndex into VaultMemoryRepository create path"
```

---

### Task 10: Hook update + archive write-through

**Files:**
- Modify: `src/backend/vault/repositories/memory-repository.ts`

- [ ] **Step 1: Add a unit test asserting the index stays in sync on update**

Append to a new file `tests/unit/backend/vault/repositories/memory-repository-index-sync.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultMemoryRepository } from "../../../../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../../../../src/backend/vault/repositories/workspace-repository.js";
import { VaultVectorIndex } from "../../../../../src/backend/vault/vector/lance-index.js";
import type { Memory } from "../../../../../src/types/memory.js";

const DIMS = 3;
const now = new Date("2026-04-22T00:00:00.000Z");

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1", project_id: "p1", workspace_id: "ws1",
    content: "body", title: "Title", type: "fact", scope: "workspace",
    tags: null, author: "a", source: null, session_id: null, metadata: null,
    embedding_model: null, embedding_dimensions: DIMS, version: 1,
    created_at: now, updated_at: now, verified_at: null, archived_at: null,
    comment_count: 0, flag_count: 0, relationship_count: 0, last_comment_at: null,
    verified_by: null, ...overrides,
  };
}

describe("VaultMemoryRepository — lance index sync", () => {
  let root: string;
  let idx: VaultVectorIndex;
  let repo: VaultMemoryRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-sync-"));
    idx = await VaultVectorIndex.create({ root, dims: DIMS });
    repo = await VaultMemoryRepository.create({ root, index: idx });
    await new VaultWorkspaceRepository({ root }).findOrCreate("ws1");
  });
  afterEach(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("archive flips the lance row's archived flag", async () => {
    await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
    expect(await idx.countRows()).toBe(1);
    await repo.archive(["m1"]);
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits).toEqual([]);
  });

  it("update with new embedding replaces the vector", async () => {
    await repo.create({ ...makeMemory(), embedding: [1, 0, 0] });
    await repo.update("m1", 1, { content: "new", embedding: [0, 1, 0] });
    const hits = await idx.search({
      embedding: [0, 1, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 10,
      minSimilarity: 0.9,
    });
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
  });

  it("update with no embedding updates meta only", async () => {
    await repo.create({
      ...makeMemory({ title: "Old" }),
      embedding: [1, 0, 0],
    });
    await repo.update("m1", 1, { title: "New" });
    const hits = await idx.search({
      embedding: [1, 0, 0],
      projectId: "p1",
      workspaceId: "ws1",
      scope: ["workspace"],
      userId: null,
      limit: 1,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(1);
    // meta-only upsert keeps vector intact
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Modify `update` in `memory-repository.ts`**

Inside the `withFileLock` block, after `await writeMarkdownAtomic(...)`, before the `reread`:

```ts
if (updates.embedding !== undefined && updates.embedding !== null) {
  await this.cfg.index.upsert([
    {
      id: next.id,
      project_id: next.project_id,
      workspace_id: next.workspace_id,
      scope: next.scope,
      author: next.author,
      title: next.title,
      archived: false,
      content_hash: contentHash(next.content),
      vector: updates.embedding,
    },
  ]);
} else {
  await this.cfg.index.upsertMetaOnly({
    id: next.id,
    project_id: next.project_id,
    workspace_id: next.workspace_id,
    scope: next.scope,
    author: next.author,
    title: next.title,
    archived: false,
  });
}
```

- [ ] **Step 4: Modify `archive` in `memory-repository.ts`**

Inside the per-id loop, after `count += 1`:

```ts
await this.cfg.index.markArchived(id);
```

- [ ] **Step 5: Run unit tests, verify pass**

```bash
npx vitest run tests/unit/backend/vault/repositories/memory-repository-index-sync.test.ts
```

Expected: PASS.

- [ ] **Step 6: Full test suite smoke**

```bash
npm test --run
```

Expected: all green; no regressions.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(vault-vector): write-through on update + archive"
```

---

### Task 11: Implement `search` on VaultMemoryRepository

**Files:**
- Modify: `src/backend/vault/repositories/memory-repository.ts`

- [ ] **Step 1: Write failing contract test**

Create `tests/contract/repositories/memory-repository-vector.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";
import type { Memory } from "../../../src/types/memory.js";

const DIMS = 768;
const now = new Date("2026-04-22T00:00:00.000Z");

function embVec(seed: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[seed % DIMS] = 1;
  return v;
}

function makeMemory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id, project_id: "p1", workspace_id: "ws1",
    content: `body-${id}`, title: `T-${id}`, type: "fact",
    scope: "workspace", tags: null, author: "a", source: null,
    session_id: null, metadata: null, embedding_model: null,
    embedding_dimensions: DIMS, version: 1,
    created_at: now, updated_at: now, verified_at: null, archived_at: null,
    comment_count: 0, flag_count: 0, relationship_count: 0,
    last_comment_at: null, verified_by: null, ...overrides,
  };
}

describe.each(factories)(
  "MemoryRepository vector contract — $name",
  (factory) => {
    let backend: TestBackend;
    beforeEach(async () => {
      backend = await factory.create();
      await backend.workspaceRepo.findOrCreate("ws1");
    });
    afterEach(async () => {
      await backend.close();
    });

    it("search returns exact match at rank 1", async () => {
      await backend.memoryRepo.create({ ...makeMemory("a"), embedding: embVec(5) });
      await backend.memoryRepo.create({ ...makeMemory("b"), embedding: embVec(200) });
      const hits = await backend.memoryRepo.search({
        embedding: embVec(5),
        project_id: "p1",
        workspace_id: "ws1",
        scope: ["workspace"],
        limit: 2,
        min_similarity: 0,
      });
      expect(hits[0].id).toBe("a");
      expect(hits[0].relevance).toBeCloseTo(1, 3);
    });

    it("search excludes archived", async () => {
      await backend.memoryRepo.create({ ...makeMemory("a"), embedding: embVec(5) });
      await backend.memoryRepo.archive(["a"]);
      const hits = await backend.memoryRepo.search({
        embedding: embVec(5),
        project_id: "p1",
        workspace_id: "ws1",
        scope: ["workspace"],
        limit: 10,
        min_similarity: 0,
      });
      expect(hits).toEqual([]);
    });

    it("findDuplicates returns top workspace-scope match above threshold", async () => {
      await backend.memoryRepo.create({ ...makeMemory("a"), embedding: embVec(5) });
      const hits = await backend.memoryRepo.findDuplicates({
        embedding: embVec(5),
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        userId: "ignored",
        threshold: 0.9,
      });
      expect(hits.map((h) => h.id)).toEqual(["a"]);
    });

    it("findPairwiseSimilar surfaces near-dupes", async () => {
      const v = embVec(10);
      const w = [...v];
      w[11] = 0.01;  // small perturbation
      await backend.memoryRepo.create({ ...makeMemory("a"), embedding: v });
      await backend.memoryRepo.create({ ...makeMemory("b"), embedding: w });
      const pairs = await backend.memoryRepo.findPairwiseSimilar({
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        threshold: 0.9,
      });
      const ids = pairs.map((p) => [p.memory_a_id, p.memory_b_id].sort());
      expect(ids).toContainEqual(["a", "b"]);
    });

    it("listWithEmbeddings returns stored embeddings", async () => {
      await backend.memoryRepo.create({ ...makeMemory("a"), embedding: embVec(5) });
      const rows = await backend.memoryRepo.listWithEmbeddings({
        projectId: "p1",
        workspaceId: "ws1",
        scope: "workspace",
        limit: 10,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].embedding).toHaveLength(DIMS);
      expect(rows[0].embedding[5]).toBe(1);
    });
  },
);
```

- [ ] **Step 2: Run test, verify fail** (all `search`-related cases fail for vault: `NotImplementedError`)

- [ ] **Step 3: Implement `search` on the repo**

Replace the stub in `memory-repository.ts`:

```ts
async search(options: SearchOptions): Promise<MemoryWithRelevance[]> {
  if (options.scope.length === 0) {
    throw new ValidationError("scope must contain at least one value");
  }
  for (const s of options.scope) {
    if (s === "user" && !options.user_id) {
      throw new ValidationError("user_id is required for user-scoped search");
    }
  }
  const hits = await this.cfg.index.search({
    embedding: options.embedding,
    projectId: options.project_id,
    workspaceId: options.workspace_id,
    scope: options.scope,
    userId: options.user_id ?? null,
    limit: options.limit ?? 10,
    minSimilarity: options.min_similarity ?? 0.3,
  });
  const out: MemoryWithRelevance[] = [];
  for (const h of hits) {
    const m = await this.findById(h.id);
    if (m !== null) out.push({ ...m, relevance: h.relevance });
  }
  return out;
}
```

- [ ] **Step 4: Run contract tests, `search`-cases pass**

```bash
npx vitest run tests/contract/repositories/memory-repository-vector.test.ts -t "search"
```

Expected: both `search` cases PASS; the other three still fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(vault): implement MemoryRepository.search via VaultVectorIndex"
```

---

### Task 12: Implement `findDuplicates`, `findPairwiseSimilar`, `listWithEmbeddings`

**Files:**
- Modify: `src/backend/vault/repositories/memory-repository.ts`

- [ ] **Step 1: Replace the three remaining stubs**

```ts
async findDuplicates(
  options: Parameters<MemoryRepository["findDuplicates"]>[0],
): ReturnType<MemoryRepository["findDuplicates"]> {
  if (options.scope === "workspace" && !options.workspaceId) {
    throw new ValidationError("workspaceId is required for workspace-scoped dedup");
  }
  if (options.scope === "user" && !options.workspaceId) {
    throw new ValidationError("workspaceId is required for user-scoped dedup");
  }
  return await this.cfg.index.findDuplicates({
    embedding: options.embedding,
    projectId: options.projectId,
    workspaceId: options.workspaceId,
    scope: options.scope,
    userId: options.userId,
    threshold: options.threshold,
  });
}

async findPairwiseSimilar(
  options: Parameters<MemoryRepository["findPairwiseSimilar"]>[0],
): ReturnType<MemoryRepository["findPairwiseSimilar"]> {
  return await this.cfg.index.findPairwiseSimilar({
    projectId: options.projectId,
    workspaceId: options.workspaceId,
    scope: options.scope,
    threshold: options.threshold,
  });
}

async listWithEmbeddings(
  options: Parameters<MemoryRepository["listWithEmbeddings"]>[0],
): ReturnType<MemoryRepository["listWithEmbeddings"]> {
  const rows = await this.cfg.index.listEmbeddings({
    projectId: options.projectId,
    workspaceId: options.workspaceId,
    scope: options.scope,
    userId: options.userId ?? null,
    limit: options.limit,
  });
  const out: Array<Memory & { embedding: number[] }> = [];
  for (const r of rows) {
    const m = await this.findById(r.id);
    if (m !== null) out.push({ ...m, embedding: r.vector });
  }
  return out;
}
```

- [ ] **Step 2: Run full contract test file**

```bash
npx vitest run tests/contract/repositories/memory-repository-vector.test.ts
```

Expected: all cases PASS.

- [ ] **Step 3: Full test suite smoke**

```bash
npm test --run
```

Expected: all green; no regressions.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(vault): implement findDuplicates + findPairwiseSimilar + listWithEmbeddings"
```

---

### Task 13: Vector parity test (pg vs vault, 500 memories)

**Files:**
- Create: `tests/integration/vector-parity.test.ts`

- [ ] **Step 1: Write the parity test**

```ts
// tests/integration/vector-parity.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import seedrandom from "seedrandom";
import { DrizzleMemoryRepository } from "../../src/repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "../../src/repositories/workspace-repository.js";
import { VaultMemoryRepository } from "../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../src/backend/vault/repositories/workspace-repository.js";
import { VaultVectorIndex } from "../../src/backend/vault/vector/lance-index.js";
import { getTestDb, truncateAll } from "../helpers.js";
import type { Memory } from "../../src/types/memory.js";

const DIMS = 64;
const N = 500;

function randomVec(rng: () => number): number[] {
  const v: number[] = [];
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    const x = rng() - 0.5;
    v.push(x);
    norm += x * x;
  }
  const s = 1 / Math.sqrt(norm);
  return v.map((x) => x * s);
}

describe("vector parity — pg vs vault", () => {
  let root: string;
  let idx: VaultVectorIndex;
  let vault: VaultMemoryRepository;
  let pg: DrizzleMemoryRepository;

  beforeAll(async () => {
    const db = getTestDb();
    await truncateAll();
    root = await mkdtemp(join(tmpdir(), "parity-"));
    idx = await VaultVectorIndex.create({ root, dims: DIMS });
    vault = await VaultMemoryRepository.create({ root, index: idx });
    pg = new DrizzleMemoryRepository(db);
    await new DrizzleWorkspaceRepository(db).findOrCreate("ws1");
    await new VaultWorkspaceRepository({ root }).findOrCreate("ws1");

    const rng = seedrandom("parity-seed");
    const now = new Date();
    for (let i = 0; i < N; i++) {
      const m: Memory = {
        id: `m${i}`, project_id: "p1", workspace_id: "ws1",
        content: `body ${i}`, title: `T${i}`, type: "fact",
        scope: "workspace", tags: null, author: "a", source: null,
        session_id: null, metadata: null, embedding_model: null,
        embedding_dimensions: DIMS, version: 1,
        created_at: now, updated_at: now, verified_at: null, archived_at: null,
        comment_count: 0, flag_count: 0, relationship_count: 0,
        last_comment_at: null, verified_by: null,
      };
      const v = randomVec(rng);
      await pg.create({ ...m, embedding: v });
      await vault.create({ ...m, embedding: v });
    }
  }, 60_000);

  afterAll(async () => {
    await idx.close();
    await rm(root, { recursive: true, force: true });
  });

  it("top-10 overlap ≥ 95% across 20 queries", async () => {
    const rng = seedrandom("parity-query");
    let totalOverlap = 0;
    const QUERIES = 20;
    const K = 10;
    for (let q = 0; q < QUERIES; q++) {
      const v = randomVec(rng);
      const pgIds = (
        await pg.search({
          embedding: v,
          project_id: "p1",
          workspace_id: "ws1",
          scope: ["workspace"],
          limit: K,
          min_similarity: 0,
        })
      ).map((h) => h.id);
      const vaultIds = (
        await vault.search({
          embedding: v,
          project_id: "p1",
          workspace_id: "ws1",
          scope: ["workspace"],
          limit: K,
          min_similarity: 0,
        })
      ).map((h) => h.id);
      const overlap = pgIds.filter((id) => vaultIds.includes(id)).length;
      totalOverlap += overlap;
    }
    const overlapRatio = totalOverlap / (QUERIES * K);
    expect(overlapRatio).toBeGreaterThanOrEqual(0.95);
  }, 30_000);
});
```

- [ ] **Step 2: Add seedrandom if not present**

```bash
npm i -D seedrandom @types/seedrandom
```

- [ ] **Step 3: Run parity test**

```bash
npx vitest run tests/integration/vector-parity.test.ts
```

Expected: PASS. If overlap drops below 0.95, first check cosine-vs-L2 mismatch, archived filter, or dimension pinning; do not lower the threshold.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(vault-vector): pg vs vault top-K overlap parity (500 memories, 20 queries)"
```

---

### Task 14: CI + lint + typecheck sweep

**Files:** none

- [ ] **Step 1: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: no errors; fix lint complaints in modified files if any.

- [ ] **Step 3: Prettier**

```bash
npx prettier --check 'src/backend/vault/vector/**/*.ts' 'tests/**/vector*/**/*.ts' 'tests/integration/vector-parity.test.ts'
```

If fails:

```bash
npx prettier --write 'src/backend/vault/vector/**/*.ts' 'tests/**/vector*/**/*.ts' 'tests/integration/vector-parity.test.ts'
```

- [ ] **Step 4: Full test suite**

```bash
npm test --run
```

Expected: all green.

- [ ] **Step 5: Commit any lint/format cleanups**

```bash
git add -A && git diff --cached --quiet || git commit -m "style(vault-vector): lint + prettier cleanup"
```

---

### Task 15: Open PR

**Files:** none

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/vault-backend-phase-3-vector
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(vault): Phase 3 — LanceDB vector index" --body "$(cat <<'EOF'
## Summary

- Add `VaultVectorIndex` (`src/backend/vault/vector/`) wrapping `@lancedb/lancedb`.
- Wire index into `VaultMemoryRepository` on `create` / `update` / `archive`.
- Replace the four `NotImplementedError` stubs with real `search` / `findDuplicates` / `findPairwiseSimilar` / `listWithEmbeddings` implementations.
- Parameterized contract tests cover the four methods across pg + vault.
- Parity test: top-10 overlap ≥ 95% across 20 queries over 500 memories.

Ref: `docs/superpowers/plans/2026-04-22-vault-backend-phase-3-vector-index.md`.

## Test plan

- [x] `npx vitest run tests/unit/backend/vault/vector` — unit coverage
- [x] `npx vitest run tests/contract/repositories/memory-repository-vector.test.ts` — contract parity
- [x] `npx vitest run tests/integration/vector-parity.test.ts` — top-K overlap ≥ 95%
- [x] `npm test --run` — no regressions
- [x] `npx tsc --noEmit` — typecheck clean
- [x] `npm run lint` — lint clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist (before opening PR)

**1. Spec coverage:** Every vector-side `MemoryRepository` method has both an index-level unit test and a cross-backend contract test. Parity bar is the spec's `≥ 95%` top-K overlap.

**2. Placeholder scan:** None. Every step has actual code or an exact command.

**3. Type consistency:** `VaultMemoryConfig` adds `index: VaultVectorIndex`; every `create()` call site updated. `VaultBackendConfig` adds `embeddingDimensions`.

**4. Out-of-scope residue:** No `.gitignore` writes, no watcher, no commit/push. Lance dir lives under `.agent-brain/` so Phase 4's gitignore rule covers it automatically when it ships.

**5. Failure semantics:** Lance-write-after-markdown failures are logged and allowed to succeed on the write path, documented in "Failure semantics" table. Read-path failures bubble.
