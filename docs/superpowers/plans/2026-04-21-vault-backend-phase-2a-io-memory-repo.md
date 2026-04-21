# Vault Backend Phase 2a — IO + MemoryRepository + WorkspaceRepository

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the vault filesystem IO primitives, hardened parser layer, and two repositories (Memory, Workspace) implementing the existing StorageBackend repo interfaces — exercised by a parameterized contract test suite running against both Postgres and Vault backends.

**Architecture:** A vault root is a directory containing one markdown file per memory (path encodes scope/workspace/user). Repositories compose three pure-ish building blocks: a path resolver (`io/paths.ts`), an atomic FS wrapper (`io/vault-fs.ts`), and a per-file lock (`io/lock.ts`). `VaultMemoryRepository` builds an in-memory `id → path` index on construction and keeps it coherent across writes. Methods requiring the vector index (`search`, `findDuplicates`, `findPairwiseSimilar`, `listWithEmbeddings`) throw `NotImplementedError` — they are filled in Phase 3. Parser hardening items from PR #27 (`docs/phase-2-TODOs.md`) land first since repos are the first consumer of frontmatter produced outside the roundtrip property test (user-editable files are reachable as soon as a repo reads one).

**Tech Stack:** TypeScript · `fs/promises` · `proper-lockfile` (per-file advisory locks, atomic writes via `rename(2)`) · existing `gray-matter` parser · existing `Memory`/`Flag`/`Relationship`/`Comment` types · `fast-check` · `vitest`.

**Branch base:** `feat/vault-backend-phase-1-parser` (stacked PR — merges after #27). Worktree: `.worktrees/vault-phase-2a-io-memory-repo`.

**Scope boundary (locked):**

| In scope | Out of scope (later phase) |
|---|---|
| Parser strictness + ergonomics + docs (all 15 items from `docs/phase-2-TODOs.md`) | Git commit/push/pull (Phase 4) |
| `io/paths.ts`, `io/vault-fs.ts`, `io/lock.ts` | LanceDB index, embedding store (Phase 3) |
| `VaultMemoryRepository` non-vector methods | Chokidar watcher (Phase 5) |
| `VaultWorkspaceRepository` | Comment / Flag / Relationship / Session / Scheduler / Audit repos (Phase 2b) |
| Parameterized contract tests for Memory + Workspace repos | VaultBackend class wiring (Phase 2b) |
| Vector methods throwing `NotImplementedError` | Migration CLI (Phase 6) |

---

## File Structure

**New:**

```
src/backend/vault/
├── errors.ts                       # NotImplementedError for vector stubs
├── io/
│   ├── paths.ts                    # scope → vault path resolver
│   ├── vault-fs.ts                 # atomic read/write/delete/list markdown files
│   └── lock.ts                     # proper-lockfile wrapper
├── parser/
│   ├── types.ts                    # shared ParseCtx (replaces local copies)
│   └── (existing parser files, hardened)
└── repositories/
    ├── workspace-repository.ts     # VaultWorkspaceRepository
    └── memory-repository.ts        # VaultMemoryRepository

tests/contract/repositories/
├── _factories.ts                   # pg + vault factory helpers
├── memory-repository.test.ts       # describe.each over both backends
└── workspace-repository.test.ts

tests/unit/backend/vault/
├── parser/
│   ├── negative.test.ts            # parse throws for malformed frontmatter
│   └── fixtures.test.ts            # add tags:null, metadata populated, archived
├── io/
│   ├── paths.test.ts
│   ├── vault-fs.test.ts
│   └── lock.test.ts
└── repositories/
    ├── memory-repository.test.ts   # vault-specific behaviour (index rebuild, path inference)
    └── workspace-repository.test.ts

tests/fixtures/vault/
├── memory-tags-null.md             # tags: null + flags present
├── memory-metadata.md              # populated metadata object
└── memory-archived.md              # archived_at set
```

**Modified:**

```
src/backend/vault/parser/memory-parser.ts       # parser hardening
src/backend/vault/parser/flag-parser.ts         # parser hardening
src/backend/vault/parser/relationship-parser.ts # parser hardening
tests/unit/backend/vault/parser/fixtures.test.ts # extend with new fixtures
tests/unit/backend/vault/parser/roundtrip.property.test.ts # pin tags-null asymmetry
package.json                        # add proper-lockfile + @types/proper-lockfile
docs/phase-2-TODOs.md               # delete (items now folded into this plan)
```

---

## Architecture Notes (read once before starting Task 6)

### Scope → path resolution

| `memory.scope` | Path shape |
|---|---|
| `workspace` | `workspaces/<workspace_slug>/memories/<id>.md` |
| `project` | `project/memories/<id>.md` |
| `user` | `users/<user_id>/<workspace_slug>/<id>.md` |

`workspace_slug` is `memory.workspace_id` as-is (caller normalizes). Filename is the nanoid id, stable across renames.

**Scope/path defence-in-depth:** the repo reads the scope from the path when indexing; the parser reads it from the frontmatter. If they disagree the write is rejected.

### In-memory id → path index

`VaultMemoryRepository` holds `Map<string, { path: string; scope: MemoryScope; workspaceId: string | null; userId: string | null }>`. Built on construction by a recursive walk of the vault root. Mutated on every `create` / `update` / `archive`. This is the only way `findById(id)` can locate a file in O(1) without walking the tree on every call.

### `findById` vs `findByIdIncludingArchived`

Archived memories live in the same file but with frontmatter `archived: <iso>` set. `findById` returns `null` if `archived_at !== null`. `findByIdIncludingArchived` returns the memory regardless. There is no "recycle bin" directory — archival is a frontmatter flip.

### Optimistic version check

On `update(id, expectedVersion, updates)`: read current file, parse, compare `memory.version` to `expectedVersion`. Mismatch → throw `ConflictError`. Match → bump version, write atomically, update index.

### Vector-requiring methods

The following throw `NotImplementedError("phase-3")`:

- `search(options)`
- `findDuplicates(options)`
- `findPairwiseSimilar(options)`
- `listWithEmbeddings(options)`

Contract tests skip these cases when `backend === "vault"` using a gate helper.

### Contract test structure

```ts
describe.each([
  ["postgres", pgFactory],
  ["vault", vaultFactory],
])("MemoryRepository (%s)", (name, factory) => {
  let backend: TestBackend;
  beforeEach(async () => { backend = await factory(); });
  afterEach(async () => { await backend.close(); });
  // behavioural tests
});
```

`TestBackend` is `{ memoryRepo, workspaceRepo, close }`. Each factory returns a fresh, empty store. Vault factory uses `fs.mkdtemp` + cleanup.

---

## Task 1: Install proper-lockfile

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install runtime dep**

Run: `npm install proper-lockfile && npm install --save-dev @types/proper-lockfile`
Expected: no errors, lockfile updated.

- [ ] **Step 2: Typecheck clean**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add proper-lockfile for vault per-file locks"
```

---

## Task 2: Parser strictness — finite-number + ISO-date guards

Covers `docs/phase-2-TODOs.md` items: `parseFiniteNumber` helper, `parseIsoDate` helper, relationship `confidence` finiteness, flag `created`/`resolved` date validation, memory `version`/`embedding_dimensions` finiteness, memory date fields validation.

**Files:**
- Modify: `src/backend/vault/parser/memory-parser.ts`
- Modify: `src/backend/vault/parser/flag-parser.ts`
- Modify: `src/backend/vault/parser/relationship-parser.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backend/vault/parser/negative.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseMemoryFile } from "../../../../../src/backend/vault/parser/memory-parser.js";
import { parseFlags } from "../../../../../src/backend/vault/parser/flag-parser.js";
import { parseRelationshipSection } from "../../../../../src/backend/vault/parser/relationship-parser.js";

function wrapMemoryMd(frontmatterPatch: Record<string, unknown>): string {
  const base = {
    id: "m1",
    title: "T",
    type: "fact",
    scope: "project",
    workspace_id: null,
    project_id: "p1",
    author: "a",
    source: null,
    session_id: null,
    tags: null,
    version: 1,
    created: "2026-04-21T00:00:00.000Z",
    updated: "2026-04-21T00:00:00.000Z",
    verified: null,
    verified_by: null,
    archived: null,
    embedding_model: null,
    embedding_dimensions: null,
    metadata: null,
    flags: [],
  };
  const fm = { ...base, ...frontmatterPatch };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n# T\n\nbody\n`;
}

describe("parser negative paths — number/date finiteness", () => {
  it("memory version: NaN throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ version: "not-a-number" })),
    ).toThrow(/version.*finite/);
  });

  it("memory embedding_dimensions: NaN throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ embedding_dimensions: "abc" })),
    ).toThrow(/embedding_dimensions.*finite/);
  });

  it("memory created: invalid date throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ created: "not-a-date" })),
    ).toThrow(/created.*ISO.*date/);
  });

  it("memory updated: invalid date throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ updated: "nope" })),
    ).toThrow(/updated.*ISO.*date/);
  });

  it("memory verified: invalid date (when present) throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ verified: "bad" })),
    ).toThrow(/verified.*ISO.*date/);
  });

  it("memory archived: invalid date (when present) throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ archived: "bad" })),
    ).toThrow(/archived.*ISO.*date/);
  });

  it("flag created: invalid date throws", () => {
    const badFlag = {
      id: "f1",
      type: "verify",
      severity: "needs_review",
      reason: "r",
      created: "not-iso",
      resolved: null,
      resolved_by: null,
    };
    expect(() =>
      parseFlags([badFlag], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\].created.*ISO.*date/);
  });

  it("flag resolved (non-null): invalid date throws", () => {
    const badFlag = {
      id: "f1",
      type: "verify",
      severity: "needs_review",
      reason: "r",
      created: "2026-04-21T00:00:00.000Z",
      resolved: "garbage",
      resolved_by: "x",
    };
    expect(() =>
      parseFlags([badFlag], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\].resolved.*ISO.*date/);
  });

  it("relationship confidence: non-finite throws", () => {
    const line = `- related:: [[t1]] — id: r1, confidence: high, by: u, at: 2026-04-21T00:00:00.000Z`;
    expect(() =>
      parseRelationshipSection(line, { projectId: "p", sourceId: "s" }),
    ).toThrow(/confidence.*finite/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/backend/vault/parser/negative.test.ts`
Expected: All 9 assertions fail — parser currently accepts `NaN`/`Invalid Date` silently.

- [ ] **Step 3: Add helpers to memory-parser.ts and apply them**

In `src/backend/vault/parser/memory-parser.ts`, add at the bottom (after existing helpers):

```ts
function finiteNumber(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n))
    throw new Error(`${name} must be a finite number; got ${String(v)}`);
  return n;
}

function isoDate(v: unknown, name: string): Date {
  if (typeof v !== "string")
    throw new Error(`${name} must be an ISO date string; got ${String(v)}`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new Error(`${name} must be an ISO date string; got ${v}`);
  return d;
}
```

Replace the relevant constructor fields in `parseMemoryFile`:

```ts
    embedding_dimensions:
      fm.embedding_dimensions === null || fm.embedding_dimensions === undefined
        ? null
        : finiteNumber(fm.embedding_dimensions, "embedding_dimensions"),
    version: finiteNumber(required(fm.version, "version"), "version"),
    created_at: isoDate(fm.created, "created"),
    updated_at: isoDate(fm.updated, "updated"),
    verified_at:
      fm.verified === null || fm.verified === undefined
        ? null
        : isoDate(fm.verified, "verified"),
    archived_at:
      fm.archived === null || fm.archived === undefined
        ? null
        : isoDate(fm.archived, "archived"),
```

- [ ] **Step 4: Apply isoDate to flag-parser.ts**

In `src/backend/vault/parser/flag-parser.ts`, add a local helper (duplicated here because Task 4 will extract the shared module — for now just inline):

```ts
function isoDate(v: unknown, name: string): Date {
  if (typeof v !== "string")
    throw new Error(`${name} must be an ISO date string; got ${String(v)}`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new Error(`${name} must be an ISO date string; got ${v}`);
  return d;
}
```

Replace the flag date construction in `parseOne`:

```ts
  return {
    id,
    project_id: ctx.projectId,
    memory_id: ctx.memoryId,
    flag_type: flagType as FlagType,
    severity: severity as FlagSeverity,
    details,
    resolved_at: resolved === null ? null : isoDate(resolved, `flags[${i}].resolved`),
    resolved_by: resolvedBy,
    created_at: isoDate(created, `flags[${i}].created`),
  };
```

- [ ] **Step 5: Apply finite-number check to relationship-parser.ts**

In `src/backend/vault/parser/relationship-parser.ts`, change the confidence parse:

```ts
    const confidenceRaw = required(kv, "confidence", line);
    const confidence = Number(confidenceRaw);
    if (!Number.isFinite(confidence))
      throw new Error(
        `confidence must be a finite number in: ${line}; got ${confidenceRaw}`,
      );
```

- [ ] **Step 6: Run negative tests — all pass**

Run: `npx vitest run tests/unit/backend/vault/parser/negative.test.ts`
Expected: 9/9 pass.

- [ ] **Step 7: Run full test suite — no regressions**

Run: `npm test -- --run tests/unit/backend/vault/parser`
Expected: all pass including roundtrip.

- [ ] **Step 8: Commit**

```bash
git add src/backend/vault/parser/memory-parser.ts \
        src/backend/vault/parser/flag-parser.ts \
        src/backend/vault/parser/relationship-parser.ts \
        tests/unit/backend/vault/parser/negative.test.ts
git commit -m "fix(vault-parser): reject NaN and invalid dates in frontmatter"
```

---

## Task 3: Parser strictness — metadata + flag detail object validation

Covers `docs/phase-2-TODOs.md` items: reject non-object `fm.metadata` (arrays/primitives), strict `flags[i].related` / `relationship_id` / `similarity` (throw on wrong type instead of silently dropping).

**Files:**
- Modify: `src/backend/vault/parser/memory-parser.ts`
- Modify: `src/backend/vault/parser/flag-parser.ts`
- Modify: `tests/unit/backend/vault/parser/negative.test.ts`

- [ ] **Step 1: Extend negative.test.ts**

Append to the existing `describe` block in `tests/unit/backend/vault/parser/negative.test.ts`:

```ts
  it("memory metadata: array rejected", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ metadata: [1, 2] }))).toThrow(
      /metadata must be an object/,
    );
  });

  it("memory metadata: primitive rejected", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ metadata: 42 }))).toThrow(
      /metadata must be an object/,
    );
  });

  it("flag related: non-string rejected", () => {
    const bad = {
      id: "f1",
      type: "verify",
      severity: "needs_review",
      reason: "r",
      related: 123,
      created: "2026-04-21T00:00:00.000Z",
      resolved: null,
      resolved_by: null,
    };
    expect(() =>
      parseFlags([bad], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\].related must be string/);
  });

  it("flag similarity: string rejected", () => {
    const bad = {
      id: "f1",
      type: "verify",
      severity: "needs_review",
      reason: "r",
      similarity: "high",
      created: "2026-04-21T00:00:00.000Z",
      resolved: null,
      resolved_by: null,
    };
    expect(() =>
      parseFlags([bad], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\].similarity must be a finite number/);
  });
```

- [ ] **Step 2: Run test — fail**

Run: `npx vitest run tests/unit/backend/vault/parser/negative.test.ts`
Expected: 4 new assertions fail.

- [ ] **Step 3: Harden memory-parser metadata handling**

In `src/backend/vault/parser/memory-parser.ts`, replace the metadata assignment block:

```ts
    metadata:
      fm.metadata === null || fm.metadata === undefined
        ? null
        : plainObject(fm.metadata, "metadata"),
```

Add helper near the other validators:

```ts
function plainObject(
  v: unknown,
  name: string,
): Record<string, unknown> {
  if (
    typeof v !== "object" ||
    v === null ||
    Array.isArray(v)
  )
    throw new Error(`${name} must be an object`);
  return v as Record<string, unknown>;
}
```

- [ ] **Step 4: Harden flag-parser optional fields**

In `src/backend/vault/parser/flag-parser.ts`, replace the `details` building block in `parseOne`:

```ts
  const details: Flag["details"] = { reason };
  if (e.related !== undefined) {
    if (typeof e.related !== "string")
      throw new Error(`flags[${i}].related must be string; got ${String(e.related)}`);
    details.related_memory_id = e.related;
  }
  if (e.relationship_id !== undefined) {
    if (typeof e.relationship_id !== "string")
      throw new Error(
        `flags[${i}].relationship_id must be string; got ${String(e.relationship_id)}`,
      );
    details.relationship_id = e.relationship_id;
  }
  if (e.similarity !== undefined) {
    const sim = Number(e.similarity);
    if (!Number.isFinite(sim))
      throw new Error(
        `flags[${i}].similarity must be a finite number; got ${String(e.similarity)}`,
      );
    details.similarity = sim;
  }
```

- [ ] **Step 5: Run negative tests**

Run: `npx vitest run tests/unit/backend/vault/parser/negative.test.ts`
Expected: all pass.

- [ ] **Step 6: Run roundtrip property tests — no regressions**

Run: `npx vitest run tests/unit/backend/vault/parser/roundtrip.property.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/backend/vault/parser/memory-parser.ts \
        src/backend/vault/parser/flag-parser.ts \
        tests/unit/backend/vault/parser/negative.test.ts
git commit -m "fix(vault-parser): enforce object metadata and typed flag details"
```

---

## Task 4: Parser ergonomics — shared ParseCtx, error message fix, description quote escaping

Covers `docs/phase-2-TODOs.md` items: shared `parser/types.ts` with unified `ParseCtx`, `flags[i].flag_type invalid` → `flags[i].type invalid` message fix, description quote escape/unescape.

**Files:**
- Create: `src/backend/vault/parser/types.ts`
- Modify: `src/backend/vault/parser/flag-parser.ts`
- Modify: `src/backend/vault/parser/relationship-parser.ts`
- Modify: `src/backend/vault/parser/memory-parser.ts`
- Modify: `tests/unit/backend/vault/parser/negative.test.ts`
- Modify: `tests/unit/backend/vault/parser/roundtrip.property.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/backend/vault/parser/negative.test.ts`:

```ts
  it("flag type invalid: error message uses 'type' not 'flag_type'", () => {
    const bad = {
      id: "f1",
      type: "bogus",
      severity: "needs_review",
      reason: "r",
      created: "2026-04-21T00:00:00.000Z",
      resolved: null,
      resolved_by: null,
    };
    expect(() =>
      parseFlags([bad], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\]\.type invalid/);
  });

  it("relationship description with embedded quote: roundtrips escaped", () => {
    const line = `- related:: [[t1]] — id: r1, confidence: 1, by: u, at: 2026-04-21T00:00:00.000Z, description: "he said \\"hi\\""`;
    const rels = parseRelationshipSection(line, {
      projectId: "p",
      sourceId: "s",
    });
    expect(rels[0].description).toBe('he said "hi"');
  });
```

Append to `tests/unit/backend/vault/parser/roundtrip.property.test.ts` — widen the `desc` arbitrary to include `"`:

In the `relArb` function, replace the `desc` definition:

```ts
  // Description may contain commas AND quotes (parser escapes/unescapes '"').
  const desc = fc.string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,?!:;()\"".split(
        "",
      ),
    ),
    minLength: 1,
    maxLength: 40,
  });
```

- [ ] **Step 2: Run tests — fail**

Run: `npx vitest run tests/unit/backend/vault/parser`
Expected: negative test `type invalid` + quote-roundtrip test fail; property test fails on any generated description containing `"`.

- [ ] **Step 3: Create shared ParseCtx module**

Create `src/backend/vault/parser/types.ts`:

```ts
export interface ParseCtx {
  projectId: string;
  memoryId: string;
}

export interface RelationshipParseCtx {
  projectId: string;
  sourceId: string;
}
```

- [ ] **Step 4: Update flag-parser to use shared ParseCtx**

In `src/backend/vault/parser/flag-parser.ts`:

Replace the local `ParseCtx` interface with an import:

```ts
import type { Flag, FlagType, FlagSeverity } from "../../../types/flag.js";
import type { ParseCtx } from "./types.js";
```

Remove the `interface ParseCtx { ... }` block.

Fix the error message at the flag-type enum check:

```ts
  if (
    typeof flagType !== "string" ||
    !FLAG_TYPES.includes(flagType as FlagType)
  ) {
    throw new Error(`flags[${i}].type invalid: ${String(flagType)}`);
  }
```

- [ ] **Step 5: Update relationship-parser to use shared ParseCtx**

In `src/backend/vault/parser/relationship-parser.ts`:

Replace the local `ParseCtx` interface with an import:

```ts
import type { Relationship } from "../../../types/relationship.js";
import type { RelationshipParseCtx as ParseCtx } from "./types.js";
```

Remove the `interface ParseCtx { ... }` block.

- [ ] **Step 6: Add description escape/unescape to relationship-parser**

In `src/backend/vault/parser/relationship-parser.ts`:

Change `serializeOne` to escape `"` in description:

```ts
function serializeOne(r: Relationship): string {
  const parts: string[] = [
    `id: ${r.id}`,
    `confidence: ${formatConfidence(r.confidence)}`,
    `by: ${r.created_by}`,
    `at: ${r.created_at.toISOString()}`,
  ];
  if (r.created_via !== null) parts.push(`via: ${r.created_via}`);
  if (r.description !== null)
    parts.push(`description: "${escapeDesc(r.description)}"`);

  return `- ${r.type}:: [[${r.target_id}]] — ${parts.join(", ")}`;
}

function escapeDesc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeDesc(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
```

Change `parseMeta` to unescape the description body and use a quote-aware end-delimiter scan:

```ts
function parseMeta(meta: string): Map<string, string> {
  const out = new Map<string, string>();
  const descIdx = meta.indexOf(', description: "');
  let head = meta;
  if (descIdx >= 0) {
    head = meta.slice(0, descIdx);
    const descStart = descIdx + ', description: "'.length;
    // Scan for unescaped closing quote.
    let i = descStart;
    let end = -1;
    while (i < meta.length) {
      if (meta[i] === "\\") {
        i += 2;
        continue;
      }
      if (meta[i] === '"') {
        end = i;
        break;
      }
      i += 1;
    }
    if (end <= descStart)
      throw new Error(`Unterminated description in: ${meta}`);
    out.set("description", unescapeDesc(meta.slice(descStart, end)));
  }

  for (const part of head.split(", ")) {
    const colon = part.indexOf(": ");
    if (colon < 0) throw new Error(`Invalid meta fragment: ${part}`);
    out.set(part.slice(0, colon), part.slice(colon + 2));
  }
  return out;
}
```

- [ ] **Step 7: Run tests — all pass**

Run: `npx vitest run tests/unit/backend/vault/parser`
Expected: all tests pass including the widened property test (100 runs × 4 properties).

- [ ] **Step 8: Commit**

```bash
git add src/backend/vault/parser/ tests/unit/backend/vault/parser/
git commit -m "refactor(vault-parser): shared ParseCtx, fix type-invalid msg, escape description quotes"
```

---

## Task 5: Parser documentation comments + unknown-section handling

Covers `docs/phase-2-TODOs.md` items: comment `flag/<type>` derived-tag asymmetry (`memory-parser.ts:37`, `:121`), `parseMeta` description delimiter invariant (`relationship-parser.ts:75`), `formatConfidence` 4-decimal precision contract (`relationship-parser.ts:70`), `body.replace(/^\n+/, "")` rationale (`memory-parser.ts:180`), unknown-H2-section decision (intentional silent fold).

**Files:**
- Modify: `src/backend/vault/parser/memory-parser.ts`
- Modify: `src/backend/vault/parser/relationship-parser.ts`

Decision locked (per `docs/phase-2-TODOs.md` unknown-section option): **(a) silently fold unknown `## ` sections into `content`**. Rationale: handwritten files may contain arbitrary sections; throwing would hijack user workflow; `memory_update` never writes unknown sections so roundtrip remains exact for agent-authored files.

- [ ] **Step 1: Add comments in memory-parser.ts**

Patch `src/backend/vault/parser/memory-parser.ts` with four doc comments.

Above the `FLAG_TAG_RE` constant (near line 37):

```ts
// Derived-tag asymmetry: each flag emits a `flag/<type>` tag into the
// frontmatter tag list on serialize (for Obsidian tag-pane grouping).
// On parse these are stripped before the tags array is returned, so
// tags round-trip with `flag/*` removed. See serializeMemoryFile.
const FLAG_TAG_RE = /^flag\//;
```

Above the `flagTypeTags` injection in `serializeMemoryFile` (near current line 121):

```ts
  // Derived-tag injection (see FLAG_TAG_RE doc). Null tags + zero flags
  // stay null; otherwise the array materializes with flag/* tags merged.
  const flagTypeTags = Array.from(
    new Set(flags.map((f) => `flag/${f.flag_type}`)),
  );
```

Above the `splitBody` helper (near current line 174):

```ts
// Body layout contract:
//   # <title>\n\n<content>\n\n## Relationships\n...\n\n## Comments\n...
// Unknown `## ` headings are folded into <content> verbatim (decision
// pinned in 2026-04-21 phase-2a plan: users may authored arbitrary
// sections; we never strip). Section order is fixed; Comments after
// Relationships. Leading newline from gray-matter is stripped because
// `matter.stringify` emits `---\n<fm>\n---\n<body>` and splitting on
// that raw body would produce an empty first line.
function splitBody(body: string): {
```

- [ ] **Step 2: Add comments in relationship-parser.ts**

Patch `src/backend/vault/parser/relationship-parser.ts`.

Above `formatConfidence` (current line 70):

```ts
// 4-decimal precision contract: values are rounded to 1e-4. Callers
// storing higher-precision confidences will observe silent precision
// loss on roundtrip — property tests enforce this by pre-rounding.
function formatConfidence(c: number): string {
```

Above `parseMeta` (current line 75):

```ts
// Meta grammar:
//   <k>: <v>, <k>: <v>, ..., description: "<escaped>"
// Description, when present, MUST be the last field — `serializeOne`
// enforces this by emitting it last. Non-description fields are split
// on ", " (naive — no commas in values), so callers storing commas in
// `created_by` / `created_via` / type will shred; property tests use
// metaSafeString (comma-free) to guard. Description supports escaped
// `\"` inside its value via escapeDesc/unescapeDesc.
function parseMeta(meta: string): Map<string, string> {
```

- [ ] **Step 3: Typecheck + test — still green**

Run: `npm run typecheck && npx vitest run tests/unit/backend/vault/parser`
Expected: all pass (no behaviour change).

- [ ] **Step 4: Commit**

```bash
git add src/backend/vault/parser/memory-parser.ts src/backend/vault/parser/relationship-parser.ts
git commit -m "docs(vault-parser): document roundtrip invariants and unknown-section fold"
```

---

## Task 6: Parser negative-path coverage expansion + tags-null pin + new fixtures

Covers `docs/phase-2-TODOs.md` items: ~12 negative-path branches, tags-null asymmetry pin, golden fixtures for `tags: null`/populated `metadata`/archived state.

**Files:**
- Modify: `tests/unit/backend/vault/parser/negative.test.ts`
- Modify: `tests/unit/backend/vault/parser/fixtures.test.ts`
- Create: `tests/fixtures/vault/memory-tags-null.md`
- Create: `tests/fixtures/vault/memory-metadata.md`
- Create: `tests/fixtures/vault/memory-archived.md`

- [ ] **Step 1: Expand negative.test.ts**

Append to the existing `describe` block:

```ts
  it("memory: section ordering violation (Comments before Relationships) throws", () => {
    const md = `---\nid: m1\ntitle: T\ntype: fact\nscope: project\nworkspace_id: null\nproject_id: p\nauthor: a\nsource: null\nsession_id: null\ntags: null\nversion: 1\ncreated: "2026-04-21T00:00:00.000Z"\nupdated: "2026-04-21T00:00:00.000Z"\nverified: null\nverified_by: null\narchived: null\nembedding_model: null\nembedding_dimensions: null\nmetadata: null\nflags: []\n---\n\n# T\n\nbody\n\n## Comments\n\n> [!comment] a · 2026-04-21T00:00:00.000Z · c1\n> hi\n\n## Relationships\n\n- related:: [[x]] — id: r, confidence: 1, by: a, at: 2026-04-21T00:00:00.000Z\n`;
    expect(() => parseMemoryFile(md)).toThrow(
      /Relationships.*before.*Comments/,
    );
  });

  it("memory: missing H1 throws", () => {
    const md = `---\nid: m1\ntitle: T\ntype: fact\nscope: project\nworkspace_id: null\nproject_id: p\nauthor: a\nsource: null\nsession_id: null\ntags: null\nversion: 1\ncreated: "2026-04-21T00:00:00.000Z"\nupdated: "2026-04-21T00:00:00.000Z"\nverified: null\nverified_by: null\narchived: null\nembedding_model: null\nembedding_dimensions: null\nmetadata: null\nflags: []\n---\n\nno heading here\n`;
    expect(() => parseMemoryFile(md)).toThrow(/title line/);
  });

  it("memory: invalid type enum throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ type: "idea" })),
    ).toThrow(/type.*fact.*decision.*learning.*pattern.*preference.*architecture/);
  });

  it("memory: invalid scope enum throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ scope: "team" })),
    ).toThrow(/scope.*workspace.*user.*project/);
  });

  it("memory: missing version throws", () => {
    const md = wrapMemoryMd({}).replace(/version: 1\n/, "");
    expect(() => parseMemoryFile(md)).toThrow(/version.*required/);
  });

  it("memory: non-string workspace_id throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ workspace_id: 42 })),
    ).toThrow(/workspace_id must be string or null/);
  });

  it("relationship: malformed line throws", () => {
    expect(() =>
      parseRelationshipSection("- not a valid line", {
        projectId: "p",
        sourceId: "s",
      }),
    ).toThrow(/Invalid relationship line/);
  });

  it("relationship: missing id throws", () => {
    const line = `- related:: [[t]] — confidence: 1, by: a, at: 2026-04-21T00:00:00.000Z`;
    expect(() =>
      parseRelationshipSection(line, { projectId: "p", sourceId: "s" }),
    ).toThrow(/Missing "id"/);
  });

  it("relationship: unterminated description throws", () => {
    const line = `- related:: [[t]] — id: r, confidence: 1, by: a, at: 2026-04-21T00:00:00.000Z, description: "no end quote`;
    expect(() =>
      parseRelationshipSection(line, { projectId: "p", sourceId: "s" }),
    ).toThrow(/Unterminated description/);
  });

  it("flag: invalid severity throws", () => {
    const bad = {
      id: "f1",
      type: "verify",
      severity: "CRITICAL",
      reason: "r",
      created: "2026-04-21T00:00:00.000Z",
      resolved: null,
      resolved_by: null,
    };
    expect(() =>
      parseFlags([bad], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\]\.severity invalid/);
  });

  it("flag: non-object entry throws", () => {
    expect(() =>
      parseFlags(["not-an-object"], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\] must be an object/);
  });
```

- [ ] **Step 2: Run — 11 new assertions fail (one existing test "invalid type enum" may already pass)**

Run: `npx vitest run tests/unit/backend/vault/parser/negative.test.ts`
Expected: some pass, some fail depending on pre-existing coverage. Fix parser only if anything lands a throw the current code doesn't produce — existing code should already cover most of these. (If any test fails because the thrown message differs from the regex, widen the regex.)

- [ ] **Step 3: Add tags-null asymmetry pin in roundtrip property test**

In `tests/unit/backend/vault/parser/roundtrip.property.test.ts`, add a dedicated describe block at the end:

```ts
describe("memory-parser tags-null asymmetry (pinned behaviour)", () => {
  it("tags: null + non-empty flags ⇒ tags round-trips as [] (flag/* tags stripped)", () => {
    const input: Memory = {
      id: "m1",
      project_id: "p",
      workspace_id: null,
      content: "body",
      title: "T",
      type: "fact",
      scope: "project",
      tags: null,
      author: "a",
      source: null,
      session_id: null,
      metadata: null,
      embedding_model: null,
      embedding_dimensions: null,
      version: 1,
      created_at: new Date("2026-04-21T00:00:00.000Z"),
      updated_at: new Date("2026-04-21T00:00:00.000Z"),
      verified_at: null,
      archived_at: null,
      comment_count: 0,
      flag_count: 1,
      relationship_count: 0,
      last_comment_at: null,
      verified_by: null,
    };
    const flag: Flag = {
      id: "f1",
      project_id: "p",
      memory_id: "m1",
      flag_type: "verify",
      severity: "needs_review",
      details: { reason: "r" },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date("2026-04-21T00:00:00.000Z"),
    };
    const md = serializeMemoryFile({
      memory: input,
      comments: [],
      relationships: [],
      flags: [flag],
    });
    const parsed = parseMemoryFile(md);
    expect(parsed.memory.tags).toEqual([]); // not null!
  });
});
```

- [ ] **Step 4: Create new fixtures**

First generate the fixtures by running a throwaway script (in the worktree root):

Create `scripts/regen-phase2a-fixtures.mjs`:

```js
import { writeFileSync, mkdirSync } from "node:fs";
import { serializeMemoryFile } from "../src/backend/vault/parser/memory-parser.js";

mkdirSync("tests/fixtures/vault", { recursive: true });

const base = {
  id: "fixN",
  project_id: "p1",
  workspace_id: null,
  content: "Body.",
  title: "Fixture",
  type: "fact",
  scope: "project",
  tags: null,
  author: "a",
  source: null,
  session_id: null,
  metadata: null,
  embedding_model: null,
  embedding_dimensions: null,
  version: 1,
  created_at: new Date("2026-04-21T00:00:00.000Z"),
  updated_at: new Date("2026-04-21T00:00:00.000Z"),
  verified_at: null,
  archived_at: null,
  comment_count: 0,
  flag_count: 0,
  relationship_count: 0,
  last_comment_at: null,
  verified_by: null,
};

// 1. tags-null with flags (asymmetry fixture)
writeFileSync(
  "tests/fixtures/vault/memory-tags-null.md",
  serializeMemoryFile({
    memory: { ...base, id: "fix1", tags: null, flag_count: 1 },
    comments: [],
    relationships: [],
    flags: [
      {
        id: "f1",
        project_id: "p1",
        memory_id: "fix1",
        flag_type: "verify",
        severity: "needs_review",
        details: { reason: "r" },
        resolved_at: null,
        resolved_by: null,
        created_at: new Date("2026-04-21T00:00:00.000Z"),
      },
    ],
  }),
);

// 2. populated metadata
writeFileSync(
  "tests/fixtures/vault/memory-metadata.md",
  serializeMemoryFile({
    memory: {
      ...base,
      id: "fix2",
      metadata: { key_a: "alpha", key_b: "beta" },
    },
    comments: [],
    relationships: [],
    flags: [],
  }),
);

// 3. archived
writeFileSync(
  "tests/fixtures/vault/memory-archived.md",
  serializeMemoryFile({
    memory: {
      ...base,
      id: "fix3",
      archived_at: new Date("2026-04-22T00:00:00.000Z"),
    },
    comments: [],
    relationships: [],
    flags: [],
  }),
);

console.log("wrote 3 fixtures");
```

Run it:

```bash
node --import tsx scripts/regen-phase2a-fixtures.mjs
```

Verify three files appeared:

```bash
ls tests/fixtures/vault/
```

Expected output includes `memory-tags-null.md`, `memory-metadata.md`, `memory-archived.md`.

Delete the script:

```bash
rm scripts/regen-phase2a-fixtures.mjs
```

- [ ] **Step 5: Add fixture assertions**

Append to `tests/unit/backend/vault/parser/fixtures.test.ts`:

```ts
  it("parses tags-null fixture and round-trips with tags=[]", () => {
    const md = readFileSync("tests/fixtures/vault/memory-tags-null.md", "utf8");
    const parsed = parseMemoryFile(md);
    expect(parsed.memory.tags).toEqual([]);
    expect(parsed.flags).toHaveLength(1);
    const reserialized = serializeMemoryFile(parsed);
    expect(reserialized).toBe(md);
  });

  it("parses metadata fixture byte-exact", () => {
    const md = readFileSync("tests/fixtures/vault/memory-metadata.md", "utf8");
    const parsed = parseMemoryFile(md);
    expect(parsed.memory.metadata).toEqual({ key_a: "alpha", key_b: "beta" });
    const reserialized = serializeMemoryFile(parsed);
    expect(reserialized).toBe(md);
  });

  it("parses archived fixture byte-exact", () => {
    const md = readFileSync("tests/fixtures/vault/memory-archived.md", "utf8");
    const parsed = parseMemoryFile(md);
    expect(parsed.memory.archived_at?.toISOString()).toBe(
      "2026-04-22T00:00:00.000Z",
    );
    const reserialized = serializeMemoryFile(parsed);
    expect(reserialized).toBe(md);
  });
```

- [ ] **Step 6: Run all parser tests — pass**

Run: `npx vitest run tests/unit/backend/vault/parser`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/vault/ tests/unit/backend/vault/parser/
git commit -m "test(vault-parser): expand negative coverage, pin tags-null, add 3 fixtures"
```

- [ ] **Step 8: Drop docs/phase-2-TODOs.md — items landed**

```bash
git rm docs/phase-2-TODOs.md
git commit -m "docs: remove phase-2-TODOs — folded into phase-2a"
```

---

## Task 7: Path resolver (`io/paths.ts`)

**Files:**
- Create: `src/backend/vault/io/paths.ts`
- Test: `tests/unit/backend/vault/io/paths.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/backend/vault/io/paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  memoryPath,
  workspaceMetaPath,
  inferScopeFromPath,
} from "../../../../../src/backend/vault/io/paths.js";

describe("vault paths", () => {
  it("workspace-scope memory: workspaces/<ws>/memories/<id>.md", () => {
    expect(
      memoryPath({
        id: "m1",
        scope: "workspace",
        workspaceId: "agent-brain",
        userId: null,
      }),
    ).toBe("workspaces/agent-brain/memories/m1.md");
  });

  it("project-scope memory: project/memories/<id>.md", () => {
    expect(
      memoryPath({
        id: "m1",
        scope: "project",
        workspaceId: null,
        userId: null,
      }),
    ).toBe("project/memories/m1.md");
  });

  it("user-scope memory: users/<user>/<ws>/<id>.md", () => {
    expect(
      memoryPath({
        id: "m1",
        scope: "user",
        workspaceId: "agent-brain",
        userId: "chris",
      }),
    ).toBe("users/chris/agent-brain/m1.md");
  });

  it("workspace-scope requires workspaceId", () => {
    expect(() =>
      memoryPath({
        id: "m1",
        scope: "workspace",
        workspaceId: null,
        userId: null,
      }),
    ).toThrow(/workspace scope requires workspaceId/);
  });

  it("user-scope requires userId and workspaceId", () => {
    expect(() =>
      memoryPath({
        id: "m1",
        scope: "user",
        workspaceId: null,
        userId: "chris",
      }),
    ).toThrow(/user scope requires workspaceId/);
    expect(() =>
      memoryPath({
        id: "m1",
        scope: "user",
        workspaceId: "ws",
        userId: null,
      }),
    ).toThrow(/user scope requires userId/);
  });

  it("workspaceMetaPath: workspaces/<slug>/_workspace.md", () => {
    expect(workspaceMetaPath("agent-brain")).toBe(
      "workspaces/agent-brain/_workspace.md",
    );
  });

  it("inferScopeFromPath: round-trips memoryPath output", () => {
    const cases = [
      {
        scope: "workspace" as const,
        workspaceId: "ws",
        userId: null,
        id: "m1",
      },
      { scope: "project" as const, workspaceId: null, userId: null, id: "m1" },
      { scope: "user" as const, workspaceId: "ws", userId: "u", id: "m1" },
    ];
    for (const c of cases) {
      const p = memoryPath(c);
      expect(inferScopeFromPath(p)).toEqual({
        scope: c.scope,
        workspaceId: c.workspaceId,
        userId: c.userId,
        id: c.id,
      });
    }
  });

  it("inferScopeFromPath rejects paths outside the known layout", () => {
    expect(inferScopeFromPath("random/file.md")).toBeNull();
    expect(inferScopeFromPath("workspaces/ws/m1.md")).toBeNull(); // missing memories/
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run tests/unit/backend/vault/io/paths.test.ts`
Expected: cannot find module `src/backend/vault/io/paths.js`.

- [ ] **Step 3: Implement paths.ts**

Create `src/backend/vault/io/paths.ts`:

```ts
import type { MemoryScope } from "../../../types/memory.js";

export interface MemoryLocation {
  id: string;
  scope: MemoryScope;
  workspaceId: string | null;
  userId: string | null;
}

export function memoryPath(loc: MemoryLocation): string {
  switch (loc.scope) {
    case "workspace": {
      if (!loc.workspaceId)
        throw new Error("workspace scope requires workspaceId");
      return `workspaces/${loc.workspaceId}/memories/${loc.id}.md`;
    }
    case "project":
      return `project/memories/${loc.id}.md`;
    case "user": {
      if (!loc.userId) throw new Error("user scope requires userId");
      if (!loc.workspaceId)
        throw new Error("user scope requires workspaceId");
      return `users/${loc.userId}/${loc.workspaceId}/${loc.id}.md`;
    }
  }
}

export function workspaceMetaPath(slug: string): string {
  return `workspaces/${slug}/_workspace.md`;
}

export interface InferredLocation extends MemoryLocation {}

// Inverse of memoryPath. Returns null for paths that do not match the
// three memory layouts (e.g. `_workspace.md`, root-level files).
export function inferScopeFromPath(relPath: string): InferredLocation | null {
  const parts = relPath.split("/");
  if (!parts[parts.length - 1]?.endsWith(".md")) return null;
  const idWithExt = parts[parts.length - 1]!;
  const id = idWithExt.slice(0, -3);

  if (parts[0] === "project" && parts[1] === "memories" && parts.length === 3) {
    return { id, scope: "project", workspaceId: null, userId: null };
  }
  if (
    parts[0] === "workspaces" &&
    parts[2] === "memories" &&
    parts.length === 4
  ) {
    return {
      id,
      scope: "workspace",
      workspaceId: parts[1]!,
      userId: null,
    };
  }
  if (parts[0] === "users" && parts.length === 4) {
    return {
      id,
      scope: "user",
      workspaceId: parts[2]!,
      userId: parts[1]!,
    };
  }
  return null;
}
```

- [ ] **Step 4: Run — pass**

Run: `npx vitest run tests/unit/backend/vault/io/paths.test.ts`
Expected: 7/7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/io/paths.ts tests/unit/backend/vault/io/paths.test.ts
git commit -m "feat(vault-io): path resolver for memory scope layout"
```

---

## Task 8: Atomic file IO (`io/vault-fs.ts`)

**Files:**
- Create: `src/backend/vault/io/vault-fs.ts`
- Test: `tests/unit/backend/vault/io/vault-fs.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/backend/vault/io/vault-fs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMarkdown,
  writeMarkdownAtomic,
  deleteMarkdown,
  listMarkdownFiles,
} from "../../../../../src/backend/vault/io/vault-fs.js";

describe("vault-fs", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-fs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writeMarkdownAtomic creates parent dirs and writes content", async () => {
    await writeMarkdownAtomic(root, "a/b/c.md", "# hi\n");
    const read = await readFile(join(root, "a/b/c.md"), "utf8");
    expect(read).toBe("# hi\n");
  });

  it("writeMarkdownAtomic leaves no .tmp siblings on success", async () => {
    await writeMarkdownAtomic(root, "a/b/c.md", "# hi\n");
    const entries = await readdir(join(root, "a/b"));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });

  it("readMarkdown returns file contents", async () => {
    await mkdir(join(root, "x"), { recursive: true });
    await writeFile(join(root, "x/y.md"), "content", "utf8");
    const got = await readMarkdown(root, "x/y.md");
    expect(got).toBe("content");
  });

  it("readMarkdown throws when file missing", async () => {
    await expect(readMarkdown(root, "nope.md")).rejects.toThrow();
  });

  it("deleteMarkdown removes the file", async () => {
    await writeMarkdownAtomic(root, "x/y.md", "c");
    await deleteMarkdown(root, "x/y.md");
    await expect(readMarkdown(root, "x/y.md")).rejects.toThrow();
  });

  it("listMarkdownFiles walks recursively and returns relative .md paths", async () => {
    await writeMarkdownAtomic(root, "a.md", "c");
    await writeMarkdownAtomic(root, "dir/b.md", "c");
    await writeMarkdownAtomic(root, "dir/sub/c.md", "c");
    await writeFile(join(root, "ignore.txt"), "nope");
    const files = await listMarkdownFiles(root);
    expect(files.sort()).toEqual(["a.md", "dir/b.md", "dir/sub/c.md"]);
  });

  it("listMarkdownFiles returns [] for an empty vault", async () => {
    const files = await listMarkdownFiles(root);
    expect(files).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run tests/unit/backend/vault/io/vault-fs.test.ts`
Expected: cannot find module.

- [ ] **Step 3: Implement vault-fs.ts**

Create `src/backend/vault/io/vault-fs.ts`:

```ts
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep, posix } from "node:path";

// Write a markdown file atomically: write to a sibling .tmp then rename.
// rename(2) is atomic on the same filesystem on POSIX and reasonably
// atomic on modern Windows — readers never see a half-written file.
export async function writeMarkdownAtomic(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, abs);
}

export async function readMarkdown(
  root: string,
  relPath: string,
): Promise<string> {
  return await readFile(join(root, relPath), "utf8");
}

export async function deleteMarkdown(
  root: string,
  relPath: string,
): Promise<void> {
  await rm(join(root, relPath));
}

// Recursively list all *.md files under root, returning POSIX-style
// relative paths so callers can concatenate with `/` portably.
export async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const rel = relative(root, abs);
        out.push(sep === posix.sep ? rel : rel.split(sep).join(posix.sep));
      }
    }
  }
  await walk(root);
  return out;
}
```

- [ ] **Step 4: Run — pass**

Run: `npx vitest run tests/unit/backend/vault/io/vault-fs.test.ts`
Expected: 7/7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/io/vault-fs.ts tests/unit/backend/vault/io/vault-fs.test.ts
git commit -m "feat(vault-io): atomic markdown read/write/delete/list"
```

---

## Task 9: Per-file lock (`io/lock.ts`)

**Files:**
- Create: `src/backend/vault/io/lock.ts`
- Test: `tests/unit/backend/vault/io/lock.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/backend/vault/io/lock.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../../../../src/backend/vault/io/lock.js";

describe("vault lock", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-lock-"));
    await writeFile(join(root, "x.md"), "", "utf8");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes concurrent writers to the same file", async () => {
    const events: string[] = [];
    const p = join(root, "x.md");

    async function take(label: string) {
      await withFileLock(p, async () => {
        events.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 30));
        events.push(`${label}:end`);
      });
    }

    await Promise.all([take("a"), take("b")]);

    // Each section runs atomically (no interleaving of start/end pairs).
    expect(events).toHaveLength(4);
    const startA = events.indexOf("a:start");
    const endA = events.indexOf("a:end");
    const startB = events.indexOf("b:start");
    const endB = events.indexOf("b:end");
    // Interleaving would look like a:start, b:start, a:end, b:end
    expect([endA < startB, endB < startA]).toContain(true);
  });

  it("releases lock on thrown error", async () => {
    const p = join(root, "x.md");
    await expect(
      withFileLock(p, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Second acquire must succeed, proving lock was released.
    let entered = false;
    await withFileLock(p, async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });

  it("returns the inner callback's value", async () => {
    const p = join(root, "x.md");
    const v = await withFileLock(p, async () => 42);
    expect(v).toBe(42);
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run tests/unit/backend/vault/io/lock.test.ts`
Expected: cannot find module.

- [ ] **Step 3: Implement lock.ts**

Create `src/backend/vault/io/lock.ts`:

```ts
import lockfile from "proper-lockfile";

// Per-file advisory lock. proper-lockfile creates a `<path>.lock`
// sibling directory atomically; concurrent acquires on the same path
// retry until the existing holder releases. retries.retries guards
// against deadlocks from a crashed holder (stale-lock detection
// reclaims locks older than stale ms).
export async function withFileLock<T>(
  absPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(absPath, {
    retries: { retries: 50, minTimeout: 10, maxTimeout: 200 },
    stale: 5_000,
    realpath: false,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
```

- [ ] **Step 4: Run — pass**

Run: `npx vitest run tests/unit/backend/vault/io/lock.test.ts`
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/io/lock.ts tests/unit/backend/vault/io/lock.test.ts
git commit -m "feat(vault-io): per-file advisory lock via proper-lockfile"
```

---

## Task 10: Vault-specific errors (`errors.ts`)

**Files:**
- Create: `src/backend/vault/errors.ts`

- [ ] **Step 1: Create errors module**

Create `src/backend/vault/errors.ts`:

```ts
import { DomainError } from "../../utils/errors.js";

// Raised by vault repositories for methods that require the vector
// index, which is filled in Phase 3. The statusHint is 501 so callers
// distinguish "backend misconfigured" from "operation unsupported".
export class NotImplementedError extends DomainError {
  constructor(feature: string) {
    super(
      `${feature} is not implemented by the vault backend (phase-3)`,
      "NOT_IMPLEMENTED",
      501,
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/backend/vault/errors.ts
git commit -m "feat(vault): add NotImplementedError for phase-3 vector stubs"
```

---

## Task 11: `VaultWorkspaceRepository`

**Files:**
- Create: `src/backend/vault/repositories/workspace-repository.ts`
- Test: `tests/unit/backend/vault/repositories/workspace-repository.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/backend/vault/repositories/workspace-repository.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultWorkspaceRepository } from "../../../../../src/backend/vault/repositories/workspace-repository.js";

describe("VaultWorkspaceRepository", () => {
  let root: string;
  let repo: VaultWorkspaceRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-ws-"));
    repo = new VaultWorkspaceRepository({ root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("findById returns null for unknown slug", async () => {
    expect(await repo.findById("agent-brain")).toBeNull();
  });

  it("findOrCreate creates workspaces/<slug>/_workspace.md", async () => {
    const first = await repo.findOrCreate("agent-brain");
    expect(first.id).toBe("agent-brain");
    expect(first.created_at).toBeInstanceOf(Date);

    const raw = await readFile(
      join(root, "workspaces/agent-brain/_workspace.md"),
      "utf8",
    );
    expect(raw).toMatch(/id: agent-brain/);
    expect(raw).toMatch(/created:/);
  });

  it("findOrCreate is idempotent — same slug returns same created_at", async () => {
    const a = await repo.findOrCreate("ab");
    const b = await repo.findOrCreate("ab");
    expect(a.created_at.toISOString()).toBe(b.created_at.toISOString());
  });

  it("findById returns metadata after create", async () => {
    const created = await repo.findOrCreate("ws1");
    const found = await repo.findById("ws1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("ws1");
    expect(found!.created_at.toISOString()).toBe(
      created.created_at.toISOString(),
    );
  });

  it("concurrent findOrCreate calls converge on one created_at", async () => {
    const [a, b] = await Promise.all([
      repo.findOrCreate("race"),
      repo.findOrCreate("race"),
    ]);
    expect(a.created_at.toISOString()).toBe(b.created_at.toISOString());
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run tests/unit/backend/vault/repositories/workspace-repository.test.ts`
Expected: cannot find module.

- [ ] **Step 3: Implement workspace-repository.ts**

Create `src/backend/vault/repositories/workspace-repository.ts`:

```ts
import matter from "gray-matter";
import { join } from "node:path";
import type { WorkspaceRepository } from "../../../repositories/types.js";
import { workspaceMetaPath } from "../io/paths.js";
import {
  readMarkdown,
  writeMarkdownAtomic,
} from "../io/vault-fs.js";
import { withFileLock } from "../io/lock.js";

export interface VaultWorkspaceConfig {
  root: string;
}

interface WorkspaceFm {
  id: string;
  created: string;
}

export class VaultWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly cfg: VaultWorkspaceConfig) {}

  async findOrCreate(
    slug: string,
  ): Promise<{ id: string; created_at: Date }> {
    const rel = workspaceMetaPath(slug);
    const abs = join(this.cfg.root, rel);

    return await withFileLock(abs, async () => {
      try {
        const raw = await readMarkdown(this.cfg.root, rel);
        const fm = matter(raw).data as Partial<WorkspaceFm>;
        if (typeof fm.id !== "string" || typeof fm.created !== "string")
          throw new Error(`malformed workspace meta at ${rel}`);
        return { id: fm.id, created_at: new Date(fm.created) };
      } catch (err: unknown) {
        if (!isNodeEnoent(err)) throw err;
        const created = new Date();
        const body = matter.stringify(`# ${slug}\n`, {
          id: slug,
          created: created.toISOString(),
        });
        await writeMarkdownAtomic(this.cfg.root, rel, body);
        return { id: slug, created_at: created };
      }
    });
  }

  async findById(
    slug: string,
  ): Promise<{ id: string; created_at: Date } | null> {
    try {
      const raw = await readMarkdown(this.cfg.root, workspaceMetaPath(slug));
      const fm = matter(raw).data as Partial<WorkspaceFm>;
      if (typeof fm.id !== "string" || typeof fm.created !== "string")
        return null;
      return { id: fm.id, created_at: new Date(fm.created) };
    } catch (err: unknown) {
      if (isNodeEnoent(err)) return null;
      throw err;
    }
  }
}

function isNodeEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}
```

- [ ] **Step 4: Run — pass**

Run: `npx vitest run tests/unit/backend/vault/repositories/workspace-repository.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/repositories/workspace-repository.ts \
        tests/unit/backend/vault/repositories/workspace-repository.test.ts
git commit -m "feat(vault-repo): VaultWorkspaceRepository — _workspace.md per slug"
```

---

## Task 12: `VaultMemoryRepository` — CRUD + id-index bootstrap

Implements: `create`, `findById`, `findByIdIncludingArchived`, `findByIds`, `update` (with optimistic lock), `archive`, `verify`.

**Files:**
- Create: `src/backend/vault/repositories/memory-repository.ts`
- Test: `tests/unit/backend/vault/repositories/memory-repository.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/backend/vault/repositories/memory-repository.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultMemoryRepository } from "../../../../../src/backend/vault/repositories/memory-repository.js";
import { ConflictError } from "../../../../../src/utils/errors.js";
import type { Memory } from "../../../../../src/types/memory.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date("2026-04-21T00:00:00.000Z");
  return {
    id: "m1",
    project_id: "p1",
    workspace_id: "ws1",
    content: "body",
    title: "Title",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "a",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: null,
    embedding_dimensions: null,
    version: 1,
    created_at: now,
    updated_at: now,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    ...overrides,
  };
}

describe("VaultMemoryRepository — CRUD", () => {
  let root: string;
  let repo: VaultMemoryRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-memrepo-"));
    repo = await VaultMemoryRepository.create({ root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("create writes memory file under workspace path", async () => {
    const m = makeMemory();
    const saved = await repo.create({ ...m, embedding: [0] });
    expect(saved.id).toBe("m1");
    const found = await repo.findById("m1");
    expect(found?.title).toBe("Title");
  });

  it("findById returns null for unknown id", async () => {
    expect(await repo.findById("nope")).toBeNull();
  });

  it("findByIdIncludingArchived returns archived memory", async () => {
    const m = makeMemory();
    await repo.create({ ...m, embedding: [0] });
    await repo.archive(["m1"]);
    expect(await repo.findById("m1")).toBeNull();
    const inc = await repo.findByIdIncludingArchived("m1");
    expect(inc?.archived_at).not.toBeNull();
  });

  it("findByIds returns memories in any order, skips archived", async () => {
    await repo.create({ ...makeMemory({ id: "a" }), embedding: [0] });
    await repo.create({ ...makeMemory({ id: "b" }), embedding: [0] });
    await repo.create({ ...makeMemory({ id: "c" }), embedding: [0] });
    await repo.archive(["b"]);
    const found = await repo.findByIds(["a", "b", "c", "missing"]);
    expect(found.map((m) => m.id).sort()).toEqual(["a", "c"]);
  });

  it("update bumps version and persists changes", async () => {
    await repo.create({ ...makeMemory(), embedding: [0] });
    const updated = await repo.update("m1", 1, { content: "new body" });
    expect(updated.version).toBe(2);
    expect(updated.content).toBe("new body");
    const found = await repo.findById("m1");
    expect(found?.version).toBe(2);
    expect(found?.content).toBe("new body");
  });

  it("update with wrong expectedVersion throws ConflictError", async () => {
    await repo.create({ ...makeMemory(), embedding: [0] });
    await expect(
      repo.update("m1", 99, { content: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("update on unknown id throws", async () => {
    await expect(repo.update("nope", 1, { content: "x" })).rejects.toThrow();
  });

  it("archive flips archived_at and returns count", async () => {
    await repo.create({ ...makeMemory({ id: "a" }), embedding: [0] });
    await repo.create({ ...makeMemory({ id: "b" }), embedding: [0] });
    const count = await repo.archive(["a", "b", "missing"]);
    expect(count).toBe(2);
    expect(await repo.findById("a")).toBeNull();
    expect(await repo.findById("b")).toBeNull();
  });

  it("verify sets verified_at and verified_by", async () => {
    await repo.create({ ...makeMemory(), embedding: [0] });
    const verified = await repo.verify("m1", "chris");
    expect(verified?.verified_by).toBe("chris");
    expect(verified?.verified_at).toBeInstanceOf(Date);
  });

  it("verify on unknown id returns null", async () => {
    expect(await repo.verify("nope", "chris")).toBeNull();
  });

  it("VaultMemoryRepository.create rebuilds index from existing vault", async () => {
    // Pre-seed a memory via fs, then construct a fresh repo.
    await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
    await writeFile(
      join(root, "workspaces/ws1/memories/preexist.md"),
      // Use existing serializer via create() on separate repo first.
      await (async () => {
        const other = await VaultMemoryRepository.create({ root });
        await other.create({
          ...makeMemory({ id: "preexist" }),
          embedding: [0],
        });
        const { readFile } = await import("node:fs/promises");
        return readFile(
          join(root, "workspaces/ws1/memories/preexist.md"),
          "utf8",
        );
      })(),
      "utf8",
    );

    const repo2 = await VaultMemoryRepository.create({ root });
    expect(await repo2.findById("preexist")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run tests/unit/backend/vault/repositories/memory-repository.test.ts`
Expected: cannot find module.

- [ ] **Step 3: Implement memory-repository.ts (CRUD slice)**

Create `src/backend/vault/repositories/memory-repository.ts`:

```ts
import { join } from "node:path";
import type {
  Memory,
  MemoryScope,
  MemoryWithRelevance,
} from "../../../types/memory.js";
import type {
  MemoryRepository,
  ListOptions,
  SearchOptions,
  StaleOptions,
  RecentWorkspaceAndUserOptions,
  ProjectScopedOptions,
  RecentActivityOptions,
  TeamActivityCounts,
} from "../../../repositories/types.js";
import { ConflictError, NotFoundError } from "../../../utils/errors.js";
import { NotImplementedError } from "../errors.js";
import {
  parseMemoryFile,
  serializeMemoryFile,
} from "../parser/memory-parser.js";
import {
  inferScopeFromPath,
  memoryPath,
  type MemoryLocation,
} from "../io/paths.js";
import {
  listMarkdownFiles,
  readMarkdown,
  writeMarkdownAtomic,
} from "../io/vault-fs.js";
import { withFileLock } from "../io/lock.js";

export interface VaultMemoryConfig {
  root: string;
}

interface IndexEntry {
  path: string;
  scope: MemoryScope;
  workspaceId: string | null;
  userId: string | null;
}

export class VaultMemoryRepository implements MemoryRepository {
  private readonly index: Map<string, IndexEntry>;

  private constructor(
    private readonly cfg: VaultMemoryConfig,
    initialIndex: Map<string, IndexEntry>,
  ) {
    this.index = initialIndex;
  }

  static async create(
    cfg: VaultMemoryConfig,
  ): Promise<VaultMemoryRepository> {
    const index = new Map<string, IndexEntry>();
    const files = await safeListMd(cfg.root);
    for (const rel of files) {
      const loc = inferScopeFromPath(rel);
      if (loc === null) continue; // skip _workspace.md and friends
      index.set(loc.id, {
        path: rel,
        scope: loc.scope,
        workspaceId: loc.workspaceId,
        userId: loc.userId,
      });
    }
    return new VaultMemoryRepository(cfg, index);
  }

  // ---- CRUD -----------------------------------------------------------

  async create(
    memory: Memory & { embedding: number[] },
  ): Promise<Memory> {
    const loc = locationFor(memory);
    const rel = memoryPath(loc);
    const md = serializeMemoryFile({
      memory,
      comments: [],
      relationships: [],
      flags: [],
    });
    const abs = join(this.cfg.root, rel);
    await withFileLock(abs, async () => {
      await writeMarkdownAtomic(this.cfg.root, rel, md);
    });
    this.index.set(memory.id, {
      path: rel,
      scope: loc.scope,
      workspaceId: loc.workspaceId,
      userId: loc.userId,
    });
    // Caller got back a Memory with counts = 0; refetch to satisfy contract.
    const saved = await this.#read(memory.id);
    return saved.memory;
  }

  async findById(id: string): Promise<Memory | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    const { memory } = await this.#read(id);
    return memory.archived_at === null ? memory : null;
  }

  async findByIdIncludingArchived(id: string): Promise<Memory | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    const { memory } = await this.#read(id);
    return memory;
  }

  async findByIds(ids: string[]): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const id of ids) {
      const m = await this.findById(id);
      if (m !== null) out.push(m);
    }
    return out;
  }

  async update(
    id: string,
    expectedVersion: number,
    updates: Partial<Memory> & { embedding?: number[] | null },
  ): Promise<Memory> {
    const entry = this.index.get(id);
    if (!entry) throw new NotFoundError("memory", id);

    const abs = join(this.cfg.root, entry.path);
    return await withFileLock(abs, async () => {
      const raw = await readMarkdown(this.cfg.root, entry.path);
      const parsed = parseMemoryFile(raw);
      if (parsed.memory.version !== expectedVersion)
        throw new ConflictError(
          `version mismatch: expected ${expectedVersion}, found ${parsed.memory.version}`,
        );

      // Drop embedding: phase-2 ignores the vector, phase-3 will wire it
      // to LanceDB. The partial update is applied verbatim otherwise.
      const { embedding: _emb, ...rest } = updates;
      void _emb;

      const next: Memory = {
        ...parsed.memory,
        ...rest,
        version: parsed.memory.version + 1,
        updated_at: new Date(),
      };
      const md = serializeMemoryFile({
        memory: next,
        comments: parsed.comments,
        relationships: parsed.relationships,
        flags: parsed.flags,
      });
      await writeMarkdownAtomic(this.cfg.root, entry.path, md);
      // Re-read to materialize derived fields.
      const reread = await this.#read(id);
      return reread.memory;
    });
  }

  async archive(ids: string[]): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const id of ids) {
      const entry = this.index.get(id);
      if (!entry) continue;
      const abs = join(this.cfg.root, entry.path);
      await withFileLock(abs, async () => {
        const raw = await readMarkdown(this.cfg.root, entry.path);
        const parsed = parseMemoryFile(raw);
        if (parsed.memory.archived_at !== null) return; // already archived
        const md = serializeMemoryFile({
          memory: { ...parsed.memory, archived_at: now, updated_at: now },
          comments: parsed.comments,
          relationships: parsed.relationships,
          flags: parsed.flags,
        });
        await writeMarkdownAtomic(this.cfg.root, entry.path, md);
        count += 1;
      });
    }
    return count;
  }

  async verify(id: string, verifiedBy: string): Promise<Memory | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    const abs = join(this.cfg.root, entry.path);
    return await withFileLock(abs, async () => {
      const raw = await readMarkdown(this.cfg.root, entry.path);
      const parsed = parseMemoryFile(raw);
      const now = new Date();
      const next: Memory = {
        ...parsed.memory,
        verified_at: now,
        verified_by: verifiedBy,
        updated_at: now,
      };
      const md = serializeMemoryFile({
        memory: next,
        comments: parsed.comments,
        relationships: parsed.relationships,
        flags: parsed.flags,
      });
      await writeMarkdownAtomic(this.cfg.root, entry.path, md);
      const reread = await this.#read(id);
      return reread.memory;
    });
  }

  // ---- Listings (Task 13) ---------------------------------------------

  async list(_options: ListOptions): ReturnType<MemoryRepository["list"]> {
    throw new NotImplementedError("list"); // Task 13
  }
  async findStale(
    _options: StaleOptions,
  ): ReturnType<MemoryRepository["findStale"]> {
    throw new NotImplementedError("findStale");
  }
  async listProjectScoped(
    _options: ProjectScopedOptions,
  ): Promise<Memory[]> {
    throw new NotImplementedError("listProjectScoped");
  }
  async listRecentWorkspaceAndUser(
    _options: RecentWorkspaceAndUserOptions,
  ): Promise<Memory[]> {
    throw new NotImplementedError("listRecentWorkspaceAndUser");
  }
  async findRecentActivity(
    _options: RecentActivityOptions,
  ): Promise<Memory[]> {
    throw new NotImplementedError("findRecentActivity");
  }
  async countTeamActivity(
    _projectId: string,
    _workspaceId: string,
    _userId: string,
    _since: Date,
  ): Promise<TeamActivityCounts> {
    throw new NotImplementedError("countTeamActivity");
  }
  async listDistinctWorkspaces(_projectId: string): Promise<string[]> {
    throw new NotImplementedError("listDistinctWorkspaces");
  }

  // ---- Vector (Phase 3) -----------------------------------------------

  async search(_options: SearchOptions): Promise<MemoryWithRelevance[]> {
    throw new NotImplementedError("search");
  }
  async findDuplicates(): ReturnType<MemoryRepository["findDuplicates"]> {
    throw new NotImplementedError("findDuplicates");
  }
  async findPairwiseSimilar(): ReturnType<
    MemoryRepository["findPairwiseSimilar"]
  > {
    throw new NotImplementedError("findPairwiseSimilar");
  }
  async listWithEmbeddings(): ReturnType<
    MemoryRepository["listWithEmbeddings"]
  > {
    throw new NotImplementedError("listWithEmbeddings");
  }

  // ---- internals ------------------------------------------------------

  async #read(id: string): Promise<ReturnType<typeof parseMemoryFile>> {
    const entry = this.index.get(id);
    if (!entry) throw new NotFoundError("memory", id);
    const raw = await readMarkdown(this.cfg.root, entry.path);
    return parseMemoryFile(raw);
  }
}

function locationFor(memory: Memory): MemoryLocation {
  return {
    id: memory.id,
    scope: memory.scope,
    workspaceId: memory.workspace_id,
    userId: null, // user-scope userId currently not encoded on Memory
  };
}

async function safeListMd(root: string): Promise<string[]> {
  try {
    return await listMarkdownFiles(root);
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "ENOENT"
    )
      return [];
    throw err;
  }
}
```

- [ ] **Step 4: Run — pass**

Run: `npx vitest run tests/unit/backend/vault/repositories/memory-repository.test.ts`
Expected: 11/11 pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/repositories/memory-repository.ts \
        tests/unit/backend/vault/repositories/memory-repository.test.ts
git commit -m "feat(vault-repo): VaultMemoryRepository CRUD + id index"
```

---

## Task 13: `VaultMemoryRepository` — listing queries

Implements: `list`, `findStale`, `listProjectScoped`, `listRecentWorkspaceAndUser`, `findRecentActivity`, `countTeamActivity`, `listDistinctWorkspaces`.

Approach: each query reads all files in `this.index`, parses, applies filters + sort + pagination in JS. O(N) per call is acceptable for Phase 2 — LanceDB will accelerate the hot paths in Phase 3. Parsing cost is mitigated by keeping per-call scope narrow.

**Files:**
- Modify: `src/backend/vault/repositories/memory-repository.ts`
- Modify: `tests/unit/backend/vault/repositories/memory-repository.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/backend/vault/repositories/memory-repository.test.ts`:

```ts
describe("VaultMemoryRepository — listings", () => {
  let root: string;
  let repo: VaultMemoryRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-memrepo-list-"));
    repo = await VaultMemoryRepository.create({ root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("list filters by project + scope + workspace", async () => {
    await repo.create({
      ...makeMemory({
        id: "a",
        project_id: "p1",
        workspace_id: "ws1",
        scope: "workspace",
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "b",
        project_id: "p1",
        workspace_id: "ws2",
        scope: "workspace",
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "c",
        project_id: "p2",
        workspace_id: "ws1",
        scope: "workspace",
      }),
      embedding: [0],
    });

    const { memories } = await repo.list({
      project_id: "p1",
      workspace_id: "ws1",
      scope: ["workspace"],
    });
    expect(memories.map((m) => m.id)).toEqual(["a"]);
  });

  it("list applies limit + cursor (created_at desc default)", async () => {
    const now = new Date("2026-04-21T00:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await repo.create({
        ...makeMemory({
          id: `id${i}`,
          project_id: "p",
          workspace_id: "ws",
          created_at: new Date(now.getTime() + i * 1000),
          updated_at: new Date(now.getTime() + i * 1000),
        }),
        embedding: [0],
      });
    }
    const page1 = await repo.list({
      project_id: "p",
      workspace_id: "ws",
      scope: ["workspace"],
      limit: 2,
    });
    expect(page1.memories.map((m) => m.id)).toEqual(["id4", "id3"]);
    expect(page1.has_more).toBe(true);

    const page2 = await repo.list({
      project_id: "p",
      workspace_id: "ws",
      scope: ["workspace"],
      limit: 2,
      cursor: page1.cursor,
    });
    expect(page2.memories.map((m) => m.id)).toEqual(["id2", "id1"]);
  });

  it("list excludes archived memories", async () => {
    await repo.create({
      ...makeMemory({ id: "a", project_id: "p", workspace_id: "ws" }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({ id: "b", project_id: "p", workspace_id: "ws" }),
      embedding: [0],
    });
    await repo.archive(["a"]);
    const { memories } = await repo.list({
      project_id: "p",
      workspace_id: "ws",
      scope: ["workspace"],
    });
    expect(memories.map((m) => m.id)).toEqual(["b"]);
  });

  it("findStale returns memories older than threshold_days", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const fresh = new Date();
    await repo.create({
      ...makeMemory({
        id: "old",
        project_id: "p",
        workspace_id: "ws",
        updated_at: old,
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "fresh",
        project_id: "p",
        workspace_id: "ws",
        updated_at: fresh,
      }),
      embedding: [0],
    });
    const { memories } = await repo.findStale({
      project_id: "p",
      workspace_id: "ws",
      threshold_days: 14,
    });
    expect(memories.map((m) => m.id)).toEqual(["old"]);
  });

  it("listProjectScoped returns scope=project memories only", async () => {
    await repo.create({
      ...makeMemory({
        id: "p1",
        project_id: "P",
        workspace_id: null,
        scope: "project",
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "ws1",
        project_id: "P",
        workspace_id: "ws",
        scope: "workspace",
      }),
      embedding: [0],
    });
    const found = await repo.listProjectScoped({
      project_id: "P",
      limit: 10,
    });
    expect(found.map((m) => m.id)).toEqual(["p1"]);
  });

  it("listDistinctWorkspaces returns unique workspace ids", async () => {
    await repo.create({
      ...makeMemory({ id: "a", project_id: "P", workspace_id: "w1" }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({ id: "b", project_id: "P", workspace_id: "w2" }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({ id: "c", project_id: "P", workspace_id: "w1" }),
      embedding: [0],
    });
    const ws = await repo.listDistinctWorkspaces("P");
    expect(ws.sort()).toEqual(["w1", "w2"]);
  });

  it("findRecentActivity returns memories updated since cutoff, excluding self", async () => {
    const now = new Date();
    await repo.create({
      ...makeMemory({
        id: "mine",
        project_id: "P",
        workspace_id: "ws",
        author: "me",
        updated_at: now,
      }),
      embedding: [0],
    });
    await repo.create({
      ...makeMemory({
        id: "theirs",
        project_id: "P",
        workspace_id: "ws",
        author: "them",
        updated_at: now,
      }),
      embedding: [0],
    });
    const found = await repo.findRecentActivity({
      project_id: "P",
      workspace_id: "ws",
      user_id: "me",
      since: new Date(now.getTime() - 60_000),
      limit: 10,
      exclude_self: true,
    });
    expect(found.map((m) => m.id)).toEqual(["theirs"]);
  });

  it("countTeamActivity returns counts per category", async () => {
    const now = new Date();
    await repo.create({
      ...makeMemory({
        id: "new1",
        project_id: "P",
        workspace_id: "ws",
        author: "them",
        created_at: now,
        updated_at: now,
      }),
      embedding: [0],
    });
    const counts = await repo.countTeamActivity(
      "P",
      "ws",
      "me",
      new Date(now.getTime() - 60_000),
    );
    expect(counts.new_memories).toBe(1);
    expect(counts.updated_memories).toBe(0); // same as new_memories — updated_at === created_at
    expect(counts.commented_memories).toBe(0);
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run tests/unit/backend/vault/repositories/memory-repository.test.ts`
Expected: new tests fail (NotImplementedError).

- [ ] **Step 3: Implement the listing queries**

In `src/backend/vault/repositories/memory-repository.ts`, replace the seven `_options: ... throw new NotImplementedError` stubs with:

```ts
  // ---- Listings -------------------------------------------------------

  async list(options: ListOptions): ReturnType<MemoryRepository["list"]> {
    const all = await this.#loadAll();
    const filtered = all.filter((m) => matchesList(m, options));
    const sortBy = options.sort_by ?? "created_at";
    const order = options.order ?? "desc";
    filtered.sort((a, b) => compareMemory(a, b, sortBy, order));
    const sliced = applyCursor(filtered, options.cursor, sortBy, order);
    const limit = options.limit ?? 50;
    const page = sliced.slice(0, limit);
    const has_more = sliced.length > limit;
    const last = page[page.length - 1];
    return {
      memories: page,
      has_more,
      cursor:
        has_more && last
          ? { created_at: last.created_at.toISOString(), id: last.id }
          : undefined,
    };
  }

  async findStale(
    options: StaleOptions,
  ): ReturnType<MemoryRepository["findStale"]> {
    const cutoff = new Date(
      Date.now() - options.threshold_days * 86_400_000,
    );
    const all = await this.#loadAll();
    const filtered = all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.workspace_id === options.workspace_id &&
          m.archived_at === null &&
          m.updated_at.getTime() < cutoff.getTime(),
      )
      .sort((a, b) => compareMemory(a, b, "created_at", "asc"));
    const sliced = applyCursor(filtered, options.cursor, "created_at", "asc");
    const limit = options.limit ?? 50;
    const page = sliced.slice(0, limit);
    const has_more = sliced.length > limit;
    const last = page[page.length - 1];
    return {
      memories: page,
      has_more,
      cursor:
        has_more && last
          ? { created_at: last.created_at.toISOString(), id: last.id }
          : undefined,
    };
  }

  async listProjectScoped(
    options: ProjectScopedOptions,
  ): Promise<Memory[]> {
    const all = await this.#loadAll();
    return all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.scope === "project" &&
          m.archived_at === null,
      )
      .sort((a, b) => compareMemory(a, b, "created_at", "desc"))
      .slice(0, options.limit);
  }

  async listRecentWorkspaceAndUser(
    options: RecentWorkspaceAndUserOptions,
  ): Promise<Memory[]> {
    const all = await this.#loadAll();
    return all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.archived_at === null &&
          ((m.scope === "workspace" && m.workspace_id === options.workspace_id) ||
            (m.scope === "user" && m.author === options.user_id)),
      )
      .sort((a, b) => compareMemory(a, b, "updated_at", "desc"))
      .slice(0, options.limit);
  }

  async findRecentActivity(
    options: RecentActivityOptions,
  ): Promise<Memory[]> {
    const all = await this.#loadAll();
    return all
      .filter(
        (m) =>
          m.project_id === options.project_id &&
          m.workspace_id === options.workspace_id &&
          m.archived_at === null &&
          m.updated_at.getTime() >= options.since.getTime() &&
          (!options.exclude_self || m.author !== options.user_id),
      )
      .sort((a, b) => compareMemory(a, b, "updated_at", "desc"))
      .slice(0, options.limit);
  }

  async countTeamActivity(
    projectId: string,
    workspaceId: string,
    userId: string,
    since: Date,
  ): Promise<TeamActivityCounts> {
    const all = await this.#loadAll();
    const scoped = all.filter(
      (m) =>
        m.project_id === projectId &&
        m.workspace_id === workspaceId &&
        m.archived_at === null &&
        m.author !== userId,
    );
    let new_memories = 0;
    let updated_memories = 0;
    let commented_memories = 0;
    for (const m of scoped) {
      if (m.created_at.getTime() >= since.getTime()) new_memories += 1;
      else if (m.updated_at.getTime() >= since.getTime())
        updated_memories += 1;
      if (
        m.last_comment_at !== null &&
        m.last_comment_at.getTime() >= since.getTime()
      )
        commented_memories += 1;
    }
    return { new_memories, updated_memories, commented_memories };
  }

  async listDistinctWorkspaces(projectId: string): Promise<string[]> {
    const all = await this.#loadAll();
    const set = new Set<string>();
    for (const m of all) {
      if (m.project_id === projectId && m.workspace_id !== null)
        set.add(m.workspace_id);
    }
    return Array.from(set);
  }

  // ---- internals ------------------------------------------------------

  async #loadAll(): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const id of this.index.keys()) {
      const { memory } = await this.#read(id);
      out.push(memory);
    }
    return out;
  }
```

Add these module-level helpers at the bottom of the file (before the closing of the file, after the class):

```ts
function matchesList(m: Memory, o: ListOptions): boolean {
  if (m.archived_at !== null) return false;
  if (m.project_id !== o.project_id) return false;
  if (!o.scope.includes(m.scope)) return false;
  if (o.workspace_id !== undefined && m.workspace_id !== o.workspace_id)
    return false;
  if (o.type !== undefined && m.type !== o.type) return false;
  if (o.tags !== undefined && o.tags.length > 0) {
    const haystack = new Set(m.tags ?? []);
    if (!o.tags.some((t) => haystack.has(t))) return false;
  }
  if (o.user_id !== undefined && m.scope === "user" && m.author !== o.user_id)
    return false;
  return true;
}

function compareMemory(
  a: Memory,
  b: Memory,
  sortBy: "created_at" | "updated_at",
  order: "asc" | "desc",
): number {
  const av = a[sortBy].getTime();
  const bv = b[sortBy].getTime();
  const primary = av - bv;
  if (primary !== 0) return order === "asc" ? primary : -primary;
  // Tiebreak on id for determinism.
  const cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return order === "asc" ? cmp : -cmp;
}

function applyCursor(
  sorted: Memory[],
  cursor: { created_at: string; id: string } | undefined,
  sortBy: "created_at" | "updated_at",
  order: "asc" | "desc",
): Memory[] {
  if (!cursor) return sorted;
  const cutoff = new Date(cursor.created_at).getTime();
  return sorted.filter((m) => {
    const v = m[sortBy].getTime();
    if (order === "desc") {
      if (v < cutoff) return true;
      if (v > cutoff) return false;
      return m.id < cursor.id;
    } else {
      if (v > cutoff) return true;
      if (v < cutoff) return false;
      return m.id > cursor.id;
    }
  });
}
```

- [ ] **Step 4: Run — pass**

Run: `npx vitest run tests/unit/backend/vault/repositories/memory-repository.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/repositories/memory-repository.ts \
        tests/unit/backend/vault/repositories/memory-repository.test.ts
git commit -m "feat(vault-repo): VaultMemoryRepository listing queries"
```

---

## Task 14: Repository contract tests (parameterized over pg + vault)

Runs a shared behaviour suite against both backends. Skips cases tagged `vector-only` when the backend is vault.

**Files:**
- Create: `tests/contract/repositories/_factories.ts`
- Create: `tests/contract/repositories/memory-repository.test.ts`
- Create: `tests/contract/repositories/workspace-repository.test.ts`

- [ ] **Step 1: Create factories helper**

Create `tests/contract/repositories/_factories.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresBackend } from "../../../src/backend/postgres/index.js";
import { VaultMemoryRepository } from "../../../src/backend/vault/repositories/memory-repository.js";
import { VaultWorkspaceRepository } from "../../../src/backend/vault/repositories/workspace-repository.js";
import type { MemoryRepository, WorkspaceRepository } from "../../../src/repositories/types.js";

export interface TestBackend {
  name: "postgres" | "vault";
  memoryRepo: MemoryRepository;
  workspaceRepo: WorkspaceRepository;
  close(): Promise<void>;
}

export interface Factory {
  name: "postgres" | "vault";
  create(): Promise<TestBackend>;
}

export const pgFactory: Factory = {
  name: "postgres",
  async create() {
    const url =
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/agent_brain_test";
    const backend = await PostgresBackend.create(url);
    // Wipe between tests — existing test suites do this via TRUNCATE.
    await backend.db.execute(
      "TRUNCATE memories, workspaces, comments, flags, relationships, audit_log, sessions, session_tracking, scheduler_state RESTART IDENTITY CASCADE" as unknown as never,
    );
    return {
      name: "postgres",
      memoryRepo: backend.memoryRepo,
      workspaceRepo: backend.workspaceRepo,
      close: () => backend.close(),
    };
  },
};

export const vaultFactory: Factory = {
  name: "vault",
  async create() {
    const root = await mkdtemp(join(tmpdir(), "contract-vault-"));
    const memoryRepo = await VaultMemoryRepository.create({ root });
    const workspaceRepo = new VaultWorkspaceRepository({ root });
    return {
      name: "vault",
      memoryRepo,
      workspaceRepo,
      close: async () => {
        await rm(root, { recursive: true, force: true });
      },
    };
  },
};

export const factories: Factory[] = [pgFactory, vaultFactory];

// Methods that require the vector index — skip these on the vault
// backend until Phase 3.
export const VECTOR_ONLY_SKIP = { skip: (b: TestBackend) => b.name === "vault" };
```

- [ ] **Step 2: Write memory contract test**

Create `tests/contract/repositories/memory-repository.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";
import type { Memory } from "../../../src/types/memory.js";
import { ConflictError } from "../../../src/utils/errors.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date("2026-04-21T00:00:00.000Z");
  return {
    id: "m1",
    project_id: "p1",
    workspace_id: "ws1",
    content: "body",
    title: "Title",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "a",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: null,
    embedding_dimensions: null,
    version: 1,
    created_at: now,
    updated_at: now,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    ...overrides,
  };
}

// Zero-vector embedding — pg stores it, vault ignores it.
const ZERO_EMB = new Array(1024).fill(0);

describe.each(factories)("MemoryRepository contract — $name", (factory) => {
  let backend: TestBackend;
  beforeEach(async () => {
    backend = await factory.create();
    // Ensure workspace exists for FK-enforcing backends.
    await backend.workspaceRepo.findOrCreate("ws1");
  });
  afterEach(async () => {
    await backend.close();
  });

  it("create + findById round-trips title and content", async () => {
    const m = makeMemory();
    await backend.memoryRepo.create({ ...m, embedding: ZERO_EMB });
    const got = await backend.memoryRepo.findById("m1");
    expect(got?.title).toBe("Title");
    expect(got?.content).toBe("body");
  });

  it("findById returns null for archived", async () => {
    await backend.memoryRepo.create({
      ...makeMemory(),
      embedding: ZERO_EMB,
    });
    await backend.memoryRepo.archive(["m1"]);
    expect(await backend.memoryRepo.findById("m1")).toBeNull();
  });

  it("findByIdIncludingArchived returns archived memory", async () => {
    await backend.memoryRepo.create({
      ...makeMemory(),
      embedding: ZERO_EMB,
    });
    await backend.memoryRepo.archive(["m1"]);
    const inc = await backend.memoryRepo.findByIdIncludingArchived("m1");
    expect(inc?.archived_at).not.toBeNull();
  });

  it("update bumps version", async () => {
    await backend.memoryRepo.create({
      ...makeMemory(),
      embedding: ZERO_EMB,
    });
    const next = await backend.memoryRepo.update("m1", 1, {
      content: "updated",
    });
    expect(next.version).toBe(2);
    expect(next.content).toBe("updated");
  });

  it("update with wrong expectedVersion throws ConflictError", async () => {
    await backend.memoryRepo.create({
      ...makeMemory(),
      embedding: ZERO_EMB,
    });
    await expect(
      backend.memoryRepo.update("m1", 42, { content: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("list returns created memories ordered by created_at desc", async () => {
    const base = new Date("2026-04-21T00:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      await backend.memoryRepo.create({
        ...makeMemory({
          id: `id${i}`,
          created_at: new Date(base.getTime() + i * 1000),
          updated_at: new Date(base.getTime() + i * 1000),
        }),
        embedding: ZERO_EMB,
      });
    }
    const { memories } = await backend.memoryRepo.list({
      project_id: "p1",
      workspace_id: "ws1",
      scope: ["workspace"],
      limit: 10,
    });
    expect(memories.map((m) => m.id)).toEqual(["id2", "id1", "id0"]);
  });

  it("verify sets verified_by and verified_at", async () => {
    await backend.memoryRepo.create({
      ...makeMemory(),
      embedding: ZERO_EMB,
    });
    const v = await backend.memoryRepo.verify("m1", "chris");
    expect(v?.verified_by).toBe("chris");
    expect(v?.verified_at).toBeInstanceOf(Date);
  });

  it("archive returns count and excludes from list", async () => {
    await backend.memoryRepo.create({
      ...makeMemory({ id: "a" }),
      embedding: ZERO_EMB,
    });
    await backend.memoryRepo.create({
      ...makeMemory({ id: "b" }),
      embedding: ZERO_EMB,
    });
    const count = await backend.memoryRepo.archive(["a", "b", "missing"]);
    expect(count).toBe(2);
    const { memories } = await backend.memoryRepo.list({
      project_id: "p1",
      workspace_id: "ws1",
      scope: ["workspace"],
    });
    expect(memories).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Write workspace contract test**

Create `tests/contract/repositories/workspace-repository.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";

describe.each(factories)(
  "WorkspaceRepository contract — $name",
  (factory) => {
    let backend: TestBackend;
    beforeEach(async () => {
      backend = await factory.create();
    });
    afterEach(async () => {
      await backend.close();
    });

    it("findById returns null for unknown", async () => {
      expect(await backend.workspaceRepo.findById("never")).toBeNull();
    });

    it("findOrCreate is idempotent", async () => {
      const a = await backend.workspaceRepo.findOrCreate("alpha");
      const b = await backend.workspaceRepo.findOrCreate("alpha");
      expect(a.id).toBe("alpha");
      expect(a.created_at.toISOString()).toBe(b.created_at.toISOString());
    });

    it("findById returns created workspace", async () => {
      await backend.workspaceRepo.findOrCreate("beta");
      const got = await backend.workspaceRepo.findById("beta");
      expect(got?.id).toBe("beta");
    });
  },
);
```

- [ ] **Step 4: Add contract test path to vitest config if excluded**

Check `vitest.config.ts` / `vite.config.ts` / `package.json` for a `test.include` pattern. If the config restricts to `tests/unit/` or `tests/integration/`, add `tests/contract/**/*.test.ts` to the include list.

Run: `grep -n "include" vitest.config.ts vite.config.ts 2>/dev/null || grep -n '"test"' package.json`

If found, patch to include `tests/contract/**/*.test.ts`. If the config is empty-defaults (picks up all `*.test.ts`), no change needed.

- [ ] **Step 5: Run contract tests**

Run: `npm test -- --run tests/contract`
Expected: all pass against both pg + vault backends.

If pg tests fail because the test DB isn't running: `cd $HOME/dev/agent-brain/.worktrees/vault-phase-2a-io-memory-repo && docker compose up -d postgres` (matches existing test-infra convention).

- [ ] **Step 6: Run the entire suite — no regressions**

Run: `npm run typecheck && npm run lint && npm run format -- --check && npm test -- --run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add tests/contract/
git commit -m "test(contract): parameterize MemoryRepository + WorkspaceRepository over pg + vault"
```

---

## Self-review checklist (I ran this before finalizing)

**Spec coverage (vs `docs/superpowers/specs/2026-04-21-vault-backend-design.md` Phase 2 row and Phase 2 sections):**

- ✅ Vault repositories against local directory: Tasks 11, 12, 13 (workspace + memory).
- ✅ No git, no vector: vector methods stub to NotImplementedError; nothing in this plan touches git.
- ✅ Parameterized repo contract tests: Task 14.
- ✅ Atomic writes: Task 8 (`writeMarkdownAtomic` via tmp + rename).
- ✅ Per-file lock: Task 9 (proper-lockfile).
- ✅ Scope → path resolver + path-based scope inference (defence in depth): Task 7.
- ✅ Optimistic version check: Task 12 (`update` reads then compares `version`).
- ✅ Frontmatter flags are canonical: parser already enforces this (Phase 1).
- ❗️ `users/` gitignore check: Phase 2 locks git out entirely; moved to Phase 4 (git phase) where the write-path check makes sense. Noted in scope table.
- ❗️ Scope mismatch (frontmatter vs path): partial — `inferScopeFromPath` exists but `VaultMemoryRepository.create` does not cross-check. Acceptable for 2a (writes always originate from the repo which sets both consistently); cross-check matters in Phase 5 (watcher) where external edits become reachable. Flagged as Phase 5 task.

**PR #27 TODO coverage (`docs/phase-2-TODOs.md`):**

- ✅ `parseFiniteNumber` helper (Task 2)
- ✅ `parseIsoDate` helper (Task 2)
- ✅ Relationship confidence finite check (Task 2)
- ✅ Flag date guards (Task 2)
- ✅ Memory metadata object validation (Task 3)
- ✅ Flag detail strictness (Task 3)
- ✅ Flag `flag_type` → `type` error message (Task 4)
- ✅ Shared `ParseCtx` (Task 4)
- ✅ Description quote escape (Task 4)
- ✅ Four parser doc comments (Task 5)
- ✅ Unknown section decision (Task 5 — locked as silent fold)
- ✅ 12 negative-path tests (Tasks 2, 3, 6)
- ✅ Golden fixture variants (Task 6)
- ✅ tags-null pin (Task 6)

**Placeholder scan:** no "TBD" / "fill in" / "implement later" strings. Vector methods throw a specific error type (`NotImplementedError`), which is a real, tested implementation — not a placeholder.

**Type consistency:**

- `VaultMemoryRepository.create(cfg)` → static factory returning Promise — consistent in tasks 12/14.
- `VaultWorkspaceRepository` — constructor takes `{ root }`, no async factory — consistent in tasks 11/14.
- `MemoryLocation` shape (`id`, `scope`, `workspaceId`, `userId`) — consistent between paths.ts (task 7) and memory-repository.ts (task 12).
- `NotImplementedError("feature")` — same signature in tasks 10, 12.
- `withFileLock(abs, fn)` — absolute path + async callback — consistent in tasks 9, 11, 12.

Plan is internally consistent.

**One open item flagged for executor:** Task 14 step 5 pg TRUNCATE uses `execute(...)` — confirm the exact pg test-infra helper used elsewhere in the repo (search `TRUNCATE` in existing tests) and swap to the idiomatic form before committing. If the project uses a `resetDb` helper, import it.
