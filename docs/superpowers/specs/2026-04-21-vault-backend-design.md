# Vault Backend Design

**Status:** design (pre-implementation)
**Date:** 2026-04-21
**Author:** chris

## Purpose

Provide a local-first, zero-infra storage backend for agent-brain as an alternative to the existing Postgres + pgvector backend. The backend uses a git-tracked Obsidian-compatible markdown vault as the source of truth, a file-based LanceDB vector index as a derived cache, and git push/pull as the team sync mechanism.

## Drivers (ranked)

1. **Kill the Postgres/Docker dependency.** Self-contained install so a developer can run agent-brain with just `npm i -g agent-brain` (or equivalent) + a git remote. No database, no container runtime, no separate service.
2. **Human-readable, co-editable memories.** Memories are plain markdown files. A user opens the vault root in Obsidian and sees memories, relationships, comments, and flags rendered natively. The agent and the user write to the same files.
3. **Portable team knowledge base.** The vault is a git repository. It can be shared, forked, cloned, reviewed in PRs, and moved between machines with zero infrastructure.

Postgres remains a supported, first-class backend. The vault backend is an additional option selected per deployment.

## Scope

**In scope:**

- A new `vault` storage backend implementing the existing `StorageBackend` interface.
- Markdown schema for memories, comments, flags, relationships, workspaces that round-trips through an Obsidian vault.
- LanceDB-backed vector index, gitignored and rebuildable from the vault.
- Git sync layer: commit-per-write, debounced async push, pull on session start.
- Chokidar watcher for external edits (e.g., edits made in Obsidian).
- Bidirectional migration CLI (pg ⇄ vault).
- Parameterized test suite that runs repository contract tests against both backends.

**Out of scope:**

- Centralized multi-client deployments against a shared vault (distributed topology only — each user runs their own server against their own clone).
- Cross-device sync for `user`-scope memories by default. An opt-in symlink pattern is documented but not automated.
- Real-time push (commits are debounced; team members see writes seconds later, not sub-second).
- Per-workspace backend switching — the backend is chosen once per deployment.

## Decisions (locked during brainstorm)

| Decision                         | Value                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Runtime shape                    | Long-running HTTP MCP server (unchanged from today)                                                                  |
| Topology                         | Distributed: each user runs their own server against their own vault clone; git remote = sync                        |
| User-scope privacy               | `users/` directory gitignored by default; optional symlink to a separately-managed private git repo for cross-device |
| Git sync cadence                 | Commit-per-write; push debounced (5s coalesce, async, retried on failure); pull on `memory_session_start`            |
| Vector index                     | LanceDB (`@lancedb/lancedb`), file-based, HNSW                                                                       |
| Postgres fate                    | Kept as supported option; vault is additive, opt-in                                                                  |
| Backend selection granularity    | Per-deployment, via `AGENT_BRAIN_BACKEND=postgres\|vault` env var                                                    |
| Abstraction seam                 | Repository-level: new `StorageBackend` interface wraps the existing 8 repository interfaces                          |
| Relationships + comments storage | Inline in the source memory file — Dataview fields under `## Relationships`, Obsidian callouts under `## Comments`   |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│             MCP Clients (Claude Code, Copilot, …)            │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP JSON-RPC
┌──────────────────────────────▼───────────────────────────────┐
│                     agent-brain MCP server                   │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐  │
│  │   Tools     │→ │  Services   │→ │  StorageBackend      │  │
│  │ (unchanged) │  │ (unchanged) │  │  (new interface)     │  │
│  └─────────────┘  └─────────────┘  └──────────┬───────────┘  │
│                                               │              │
│                   ┌───────────────────────────┴──────────┐   │
│           ┌───────▼─────────┐                  ┌─────────▼─────────┐
│           │ PostgresBackend │                  │   VaultBackend    │
│           │ (existing repos)│                  │                   │
│           └───────┬─────────┘                  └────┬──────────────┘
│                   │                                 │
│         ┌─────────▼────────┐           ┌────────────┼───────────────┐
│         │ Postgres +       │           │            │               │
│         │ pgvector         │   ┌───────▼────┐ ┌─────▼────┐  ┌───────▼─────┐
│         └──────────────────┘   │ Vault FS   │ │ LanceDB  │  │ Git ops     │
│                                │ (markdown) │ │ (vectors)│  │ (commit,    │
│                                └────────────┘ └──────────┘  │  push, pull)│
│                                                             └─────────────┘
└──────────────────────────────────────────────────────────────┘
                                                              │
                                                  ┌───────────▼────────────┐
                                                  │   git remote (origin)  │
                                                  │   shared vault repo    │
                                                  └────────────────────────┘
```

**Key properties:**

- **Single backend per deployment**, chosen by `AGENT_BRAIN_BACKEND`.
- **Tools and services layer untouched.** New code is localized under `src/backend/vault/`.
- **Vault = source of truth.** LanceDB index is a derived cache (rebuildable). Git history is the audit log. Runtime state (sessions, scheduler, vector index) lives under `.agent-brain/` and is gitignored.
- **Distributed topology.** Each user runs their own server against their own clone. Writes commit locally and are pushed asynchronously. `memory_session_start` pulls before serving.
- **Obsidian-native.** Opening the vault root in Obsidian presents a first-class knowledge graph: files per memory, wikilinks between them, callouts for comments, nested tags for flags, Dataview inline fields for typed relationships.

## Vault layout

```
<vault-root>/
├── .obsidian/                       # optional, checked in or gitignored per user pref
├── .agent-brain/                    # runtime state, gitignored
│   ├── index.lance/                 # LanceDB vector index
│   ├── sessions.json                # live session budgets + session_tracking
│   ├── scheduler.json               # scheduler_state
│   └── config.json                  # project_id, embedding model/dims
├── workspaces/
│   └── <workspace-slug>/
│       ├── _workspace.md            # workspace metadata (frontmatter only)
│       └── memories/
│           └── <memory-id>.md       # one file per workspace-scoped memory
├── project/                         # project-scope memories (cross-workspace)
│   └── memories/
│       └── <memory-id>.md
├── users/                           # user-scope (private) memories — gitignored by default
│   └── <user-id>/
│       └── <workspace-slug>/
│           └── <memory-id>.md
├── .gitignore                       # ignores .agent-brain/ and (default) users/
└── .gitattributes                   # *.md merge=union for append-friendly merges
```

**Rationale:**

- One file per memory. Folder path encodes scope + workspace. The repository infers scope from path, not only frontmatter — defence in depth against misfiled or manually moved files.
- Filename is the nanoid memory id, not the title. Stable across title changes; no rename churn in git.
- Obsidian sees the whole vault. Wikilinks `[[<id>]]` resolve across scopes.
- `users/` gitignored by default keeps private memories local. Users who want cross-device sync symlink `users/<id>/` to a separately-cloned private git repo; from Obsidian's perspective the vault looks unified, while git sees two independent repositories.

## Memory file schema

```markdown
---
id: n86khHlXf88S8Fq4i1NwT
title: Keep claude + copilot instruction snippets in sync
type: pattern # fact | decision | learning | pattern | preference | architecture
scope: workspace # workspace | user | project
workspace_id: agent-brain # null for project-scope
user_id: null # set for user-scope
project_id: PERSONAL_PROJECTS
author: chris
source: manual # manual | agent-auto | session-review | consolidation
session_id: s_abc123 # null if not applicable
tags: [hooks, snippets, claude, copilot]
version: 3
created: 2026-04-21T10:15:00Z
updated: 2026-04-21T11:02:00Z
verified: 2026-04-21T11:02:00Z
verified_by: chris
archived: null
last_comment: 2026-04-21T11:00:00Z
embedding_model: amazon.titan-embed-text-v2:0
embedding_dimensions: 1024
metadata: {}
flags:
  - id: f_xyz
    type: verify # duplicate | contradiction | override | superseded | verify
    severity: needs_review # auto_resolved | needs_review
    reason: referenced file may be renamed
    related: n_other123
    similarity: 0.91
    created: 2026-04-21T10:20:00Z
    resolved: null
    resolved_by: null
---

# Keep claude + copilot instruction snippets in sync

Body markdown. Link to other memories with `[[n_other123|Title]]`.

## Relationships

- supersedes:: [[n_oldversion]] — confidence: 1.0, via: consolidation
- related:: [[n_sibling]] — confidence: 0.8, via: manual

## Comments

> [!comment] chris · 2026-04-21T11:00:00Z · c_abc
> Confirmed still accurate after April sync.

> [!comment] alice · 2026-04-21T11:30:00Z · c_def
> Added CI check, see PR #42.
```

**Notes:**

- Embedding vectors are **not** stored in the file. They live only in the LanceDB index (rebuildable). This keeps memory files small and diff-friendly.
- Frontmatter `flags` array is the canonical flag store. A derived `#flag/<type>` tag is emitted into the body tag list for Obsidian tag-pane grouping.
- `## Relationships` uses Dataview inline-field syntax (`type:: [[target]]`) so Dataview queries work, while plain-Obsidian users still see sensible markdown and wikilinks.
- Comments use Obsidian callouts. The header line encodes `author · ISO timestamp · comment_id` deterministically so the parser can round-trip.

## Entity mapping (vault vs runtime vs git history)

| Current table      | Vault location  | Format                                                                                                                                                                                             |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memories`         | vault markdown  | per-file, as above                                                                                                                                                                                 |
| `comments`         | vault markdown  | callout blocks inside memory file                                                                                                                                                                  |
| `flags`            | vault markdown  | `flags:` array in frontmatter of memory file                                                                                                                                                       |
| `relationships`    | vault markdown  | inline Dataview fields under `## Relationships` in the source-side memory file                                                                                                                     |
| `workspaces`       | vault markdown  | `workspaces/<slug>/_workspace.md` (frontmatter only)                                                                                                                                               |
| `audit_log`        | **git history** | every mutation is a commit; commit trailers `AB-Action:`, `AB-Memory:`, `AB-Actor:`, `AB-Reason:` carry structured audit fields; `git log --follow <file>` serves `AuditRepository.findByMemoryId` |
| `sessions`         | runtime JSON    | `.agent-brain/sessions.json`, gitignored                                                                                                                                                           |
| `session_tracking` | runtime JSON    | same file                                                                                                                                                                                          |
| `scheduler_state`  | runtime JSON    | `.agent-brain/scheduler.json`, gitignored                                                                                                                                                          |

## Components

```
src/backend/
├── types.ts                        # StorageBackend interface + factory type
├── factory.ts                      # reads config, returns backend instance
├── postgres/
│   ├── index.ts                    # PostgresBackend: wraps existing repos
│   └── (re-exports src/repositories/* unchanged)
└── vault/
    ├── index.ts                    # VaultBackend: wires everything, implements StorageBackend
    ├── config.ts                   # vault path, remote URL, sync cadence
    │
    ├── io/
    │   ├── paths.ts                # scope → folder path resolver
    │   ├── vault-fs.ts             # read/write markdown files (atomic writes via rename)
    │   └── lock.ts                 # per-file write lock (proper-lockfile)
    │
    ├── parser/
    │   ├── memory-parser.ts        # .md ⇄ Memory (gray-matter for frontmatter)
    │   ├── flag-parser.ts          # frontmatter flags array ⇄ Flag[]
    │   ├── relationship-parser.ts  # "## Relationships" section ⇄ Relationship[]
    │   ├── comment-parser.ts       # callout blocks ⇄ Comment[]
    │   └── roundtrip.test.ts       # property-based roundtrip coverage
    │
    ├── repositories/
    │   ├── memory-repository.ts            # implements MemoryRepository
    │   ├── comment-repository.ts           # append callout to source memory file
    │   ├── flag-repository.ts              # mutate frontmatter flags
    │   ├── relationship-repository.ts      # mutate "## Relationships" in source file
    │   ├── workspace-repository.ts         # _workspace.md
    │   ├── audit-repository.ts             # git log parser
    │   ├── session-repository.ts           # .agent-brain/sessions.json
    │   ├── session-tracking-repository.ts  # same file
    │   └── scheduler-state-repository.ts   # .agent-brain/scheduler.json
    │
    ├── vector/
    │   ├── lance-index.ts          # LanceDB wrapper: upsert, delete, query, rebuild
    │   ├── embedding-cache.ts      # sha256(body) → embedding, skip re-embed on no-op
    │   └── reindex.ts              # scan vault, diff against index, embed changed
    │
    ├── git/
    │   ├── git-ops.ts              # commit, pull --rebase --autostash, push, status
    │   ├── trailers.ts             # AB-Action: / AB-Memory: / AB-Actor: commit trailers
    │   ├── push-queue.ts           # debounced async push (5s coalesce, single-flight)
    │   └── merge-driver.ts         # installer for union merge on markdown
    │
    ├── watcher.ts                  # chokidar: external file changes → reindex + cache invalidate
    │
    └── migrate/
        ├── pg-to-vault.ts          # CLI: stream pg → vault files (preserves timestamps)
        └── vault-to-pg.ts          # reverse
```

### Unit boundaries

| Unit                        | Purpose                                                                     | Depends on                       | Interface                                               |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| `parser/*`                  | Pure functions: markdown ⇄ domain objects. No I/O.                          | `gray-matter`, regex only        | `parse(str): T`, `serialize(T): str`                    |
| `io/vault-fs.ts`            | File reads/writes, atomic rename, per-file locks                            | `fs/promises`, `proper-lockfile` | `readMemory(path)`, `writeMemory(path, content, lock)`  |
| `vector/lance-index.ts`     | Vector upsert/query/delete. No business logic.                              | `@lancedb/lancedb`               | `upsert(Memory[])`, `query(emb, filter)`, `delete(ids)` |
| `git/git-ops.ts`            | Shell to `git`. No domain knowledge.                                        | `simple-git`                     | `commit(paths, trailer)`, `pull()`, `push()`            |
| `git/push-queue.ts`         | Debounce + single-flight push                                               | `git-ops`                        | `request()`                                             |
| `watcher.ts`                | File change events → callback                                               | `chokidar`                       | `onChange(cb)`                                          |
| `repositories/*`            | Compose io + parser + vector + git. Implement the existing repo interfaces. | all of the above                 | matches `src/repositories/types.ts`                     |
| `VaultBackend` (`index.ts`) | DI root. Wires repos, starts watcher + push queue, handles shutdown.        | all                              | `StorageBackend`                                        |

Each repository write method follows the same pipeline: read file → parse → mutate → serialize → atomic write → update LanceDB → stage + commit → enqueue push.

### New dependencies

- `@lancedb/lancedb` — vector index
- `gray-matter` — YAML frontmatter parse
- `simple-git` — git wrapper
- `chokidar` — file watch
- `proper-lockfile` — per-file locks

## Data flow

### Write: `memory_create`

```
memory_create → MemoryService.create
  ├─ embed(content) via EmbeddingProvider (unchanged)
  ├─ repo.create(memory, embedding)  — vault impl:
  │    ├─ paths.forScope(scope, ws, user) → file path
  │    ├─ lock.acquire(path)
  │    ├─ parser.serialize(memory) → markdown
  │    ├─ vault-fs.writeAtomic(path, md)     # tmp → rename
  │    ├─ lance.upsert({id, vec, meta, hash})
  │    ├─ git.stage(path)
  │    ├─ git.commit("AB-Action: created\nAB-Memory: <id>\nAB-Actor: <author>")
  │    ├─ lock.release(path)
  │    └─ pushQueue.request()                # debounced async
  └─ return Memory
```

- Commit is synchronous on the write path. Push is fire-and-forget and retried.
- Embedding is computed once; `content_hash` is stored in LanceDB so `memory_update` can skip re-embedding when the body is unchanged.
- The lock is per-file, not per-vault, so concurrent writes to different memories do not serialize.

### Write: `memory_comment`

Same shape, but the repository loads the source memory file, appends a callout block, writes back, stages, commits. Comment id (nanoid) is embedded in the callout header for round-trip. LanceDB is not touched (embedding unchanged).

### Write: `memory_relate`

Loads the source memory file, parses `## Relationships`, inserts a Dataview inline-field line, writes back. Target file is untouched (backlinks are auto-derived from the wikilink).

### Read: `memory_search`

```
memory_search → MemoryService.search
  ├─ embed(query)
  └─ repo.search({embedding, filters})   — vault impl:
       ├─ lance.query(embedding, filter) → [{id, score, path}, …]
       ├─ for each id: vault-fs.read(path) + parser.parse (parallel)
       └─ return MemoryWithRelevance[]
```

Hot path = LanceDB query + parallel file reads. Git is not touched.

### Read: `memory_session_start`

```
memory_session_start
  ├─ git.pull(--rebase --autostash)
  │   ├─ ok               → proceed
  │   ├─ conflict (auto)  → merge=union resolves; proceed
  │   ├─ conflict (hard)  → rebase --abort; serve stale; flag affected memories
  │   └─ offline          → serve local; meta.offline = true
  ├─ detect changed paths since last pull (git diff)
  ├─ reindex diff via lance.upsert
  └─ normal session_start flow (MemoryService unchanged)
```

### External edit (user edits a memory file in Obsidian)

```
chokidar event → watcher.ts
  ├─ debounce(200ms)
  ├─ parser.parse(file)
  ├─ if parse error: log + include path in parse_errors; serve previous index entry
  ├─ if content_hash changed → re-embed + lance.upsert
  └─ if only flags/relationships/comments changed → lance.upsert(metadata only)
```

**Decision:** external edits are **not** auto-committed. The user running Obsidian is expected to commit manually (or via the Obsidian Git plugin). Agent-brain auto-commits only writes originating from MCP tools, keeping actor attribution clean and avoiding fights with the user's own git workflow.

### Shutdown

`VaultBackend.close()`:

1. Drain pending writes.
2. Force-flush the push queue.
3. Wait for in-flight git ops.
4. Close the LanceDB connection.
5. Persist `sessions.json` and `scheduler.json`.

## Error handling

### Failure modes

| Failure                                             | Detection                   | Response                                                                                                                                                            |
| --------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Atomic rename mid-write                             | `.tmp` left behind          | Sweep on startup; caller sees error and retries                                                                                                                     |
| LanceDB upsert fails after successful fs write      | `lance.upsert` throws       | Log + enqueue repair; background reindex picks it up. Caller sees success (vault = source of truth)                                                                 |
| `git commit` fails after fs + lance succeed         | non-zero exit               | Repair queue retries on next write or session_start. Caller sees success                                                                                            |
| `git push` fails                                    | non-zero exit               | push-queue marks dirty and retries (5s → 30s → 5m → 30m backoff). Writes never block. `meta.unpushed_commits` exposed on `session_start` envelope                   |
| Pull conflict (auto-resolvable)                     | merge=union on markdown     | YAML frontmatter silently union-merged; invalid YAML surfaces as `parse_errors` on next read. Other conflicts (content, only/delete) surface `pull_conflict: true`. |
| Pull conflict (unresolvable)                        | post-rebase `git status`    | `git rebase --abort`; serve stale; create `verify` flag on affected memories; `meta.pull_conflict = true`                                                           |
| Offline on pull                                     | network error               | Serve local; `meta.offline = true`; writes queue for push                                                                                                           |
| Parse error (invalid frontmatter after manual edit) | `parser.parse` throws       | Skip file; `meta.parse_errors` includes path; previous index entry still served                                                                                     |
| LanceDB corruption / schema mismatch                | startup check               | Full reindex from vault; blocks startup until complete; vault is source of truth so no data loss                                                                    |
| Vault missing or not a git repo                     | startup validation          | Hard fail with remediation text; no silent recovery                                                                                                                 |
| Disk full                                           | fs write error              | Propagate as tool error; no partial index update                                                                                                                    |
| Concurrent writes to same memory                    | per-file lock               | Second write waits up to 5s then throws; tool retries or surfaces timeout                                                                                           |
| Race: external edit + tool write                    | lock + watcher queue        | Tool holds lock during its path; watcher reindex queues after lock release                                                                                          |
| Optimistic version mismatch                         | parsed `version` ≠ expected | Existing `OptimisticLockError` contract — unchanged                                                                                                                 |
| Malformed commit trailers on migration              | audit-log parser            | Skip for audit purposes, treat as external commit                                                                                                                   |

### Invariants

- Write ordering: **lock → fs → lance → git stage → git commit → lock release → push queue**. If any step before `git commit` fails, compensating action rolls back the lance write before raising.
- `git commit --no-verify` is never used unless the user's own hooks interfere; hook failures surface, not silently bypassed.
- No destructive recovery at runtime (`reset --hard`, `rm -rf`, `rebase --abort --hard`). Destructive repair only happens under explicit `agent-brain repair` CLI invocation.
- `users/` privacy: the write path verifies the `.gitignore` rule is still present before writing a user-scope memory. Missing ignore aborts the write.

### Envelope surface (exposed via `memory_session_start` response)

```
meta: {
  offline?: true,
  unpushed_commits?: number,
  pull_conflict?: true,
  parse_errors?: string[],
  lance_reindexed?: true
}
```

Agents show non-empty fields to the user.

## Testing

**1. Parser roundtrip (pure, fast).** `vitest` + `fast-check`. `parse(serialize(x)) === x` for Memory, Comment, Flag, Relationship. Plus golden-file fixtures under `tests/fixtures/vault/` for byte-for-byte stability.

**2. Repository contract parity.** The existing pg repo test suite is parameterized over both backends:

```ts
describe.each([
  ["postgres", () => new PostgresBackend(testPgUrl)],
  ["vault", () => new VaultBackend(tmpVaultPath)],
])("MemoryRepository (%s)", (name, factory) => {
  /* existing tests */
});
```

Forces behavioral parity; divergence = test failure.

**3. Vector parity.** ~500 memories embedded with the same model, inserted into pg + lance, same query set. Assert top-K overlap ≥ 95% and per-match score delta ≤ 0.01.

**4. Git sync integration.** Local bare repo as "remote", two ephemeral clones, simulate: single-writer, concurrent non-conflicting writes, auto-resolvable conflict, unresolvable conflict (flag raised), offline.

**5. Watcher / external edit.** Modify file on disk, wait for debounce, assert repo sees new content. Invalid frontmatter → parse_errors logged, previous version still served.

**6. Migration E2E.** Seed pg with ~200 memories + comments/flags/relationships. Run pg→vault. Start VaultBackend against migrated vault. `findById` returns structurally-equal objects. Reverse vault→pg and compare to original dump.

**7. Server-boot smoke (extend existing).** `tests/unit/server-boot.test.ts` already spawns `node --import tsx` on `src/server.ts`. Extend to run twice with `AGENT_BRAIN_BACKEND=postgres` and `AGENT_BRAIN_BACKEND=vault` to catch ESM/CJS interop on new native deps (`@lancedb/lancedb`).

**8. Performance regression.** Budget targets:

- Cold start ≤ 2s up to 10k memories.
- Search p99 ≤ 50ms.
- Write p99 ≤ 200ms (including sync commit).

### CI layering

- Unit + parser on every push.
- Integration (both backends) on PR — requires pg container + git.
- Benchmarks nightly (or on `perf:` label).
- Coverage gate: parsers ≥ 95%, repositories ≥ 85%.

## Phased rollout

| Phase | Deliverable                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `StorageBackend` interface extraction. Move existing drizzle repos behind factory. No behavior change. Green tests.                    |
| 1     | Vault parser + serializer (pure). Roundtrip property tests for all entity types.                                                       |
| 2     | Vault repositories against a local directory (no git, no vector). Parameterized repo contract tests pass against both backends.        |
| 3     | LanceDB index integration. Vector parity tests.                                                                                        |
| 4a    | Git write path: commit-on-write, `AB-*` trailers, bootstrap `.gitignore`/`.gitattributes`, `users/` privacy invariant. **Done — #34.** |
| 4b    | Push queue + pull-on-session_start. Debounced push, rebase pull, diff-driven reindex, conflict/offline meta. **Done — #37.**           |
| 4c    | `VaultAuditRepository` on git log + smart YAML merge driver (`agent-brain-memory`). **Done — #39.**                                    |
| 4d    | Surface `parse_errors` as per-memory flags (consolidation producer) + write-path perf budget verification under load. **Done — #TBD.** |
| 5     | Chokidar watcher + boot reconcile + parse_error live producer + lance↔markdown drift repair. **Done — #TBD.**                          |
| 6     | Migration CLI + reverse migration.                                                                                                     |
| 7     | Docs, recommended Obsidian vault template (Dataview, Tasks plugins), README updates.                                                   |

## Open questions

None required before writing the implementation plan. All architectural decisions are locked in the "Decisions" section above. Implementation-level choices (e.g. exact LanceDB schema column list, exact trailer grammar) are plan-time details.
