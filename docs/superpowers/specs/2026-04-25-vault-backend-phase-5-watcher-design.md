# Vault Backend Phase 5 — Chokidar Watcher + External Edit E2E

**Status:** Design approved 2026-04-25. Ready for implementation plan.

**Roadmap source:** `docs/superpowers/specs/2026-04-21-vault-backend-design.md` line 458 — "Chokidar watcher. External edit E2E."

**Predecessor phases:** 4a (#34, git write path), 4b (#37, push queue + pull), 4c (#39, audit + merge driver), 4d (#41, parse-error flags + perf benchmarks). Main is clean baseline as of commit `dab283d` (PR #42, null-stripping replacer).

## Goals

1. **Watcher.** Detect external edits to `<vault>/**/*.md` (Obsidian saves, vim writes, `git pull` checkouts) and reconcile lance vector index + `VaultIndex` (path/id map + unindexable list) + open `parse_error` flags.
2. **Boot reconcile.** Run a vault-wide pre-listen scan that brings lance and in-memory state into agreement with disk before HTTP accepts requests. Repairs lance↔markdown drift left over from any earlier crash.
3. **Subsume PR #37 deferred gap.** `VaultMemoryRepository.syncPaths` previously added pulled paths to the in-memory index but did not remove deletions. Watcher's `unlink` event subsumes this — no separate `syncPaths` patch needed.
4. **Close Phase 4d live-edit gap.** Phase 4d `parse_error` flag producer (`VaultParseErrorChecker` in `src/backend/vault/parse-error-checker.ts`) only ran during consolidation, not on live edits. Watcher gives a live signal source so external edits that break frontmatter surface as flags / `unindexable` entries without restart.

Non-goals: see "Non-Goals" section.

## Decisions

### D1. Scope = full closure (Q1 / D)

Phase 5 ships watcher + boot reindex + parse_error live coupling in one cycle. Reasoning: watcher is the single natural producer of "file changed" reactions; splitting these into separate phases re-touches the same code path multiple times. Phase 3 `content_hash` skip and Phase 4d `parse_error` resurface fall out for free once watcher exists.

### D2. Self-write filtering = in-flight ignore set with mtime tuple (Q2 / A + R2 refinement)

A `Set<absPath, mtimeAfterWrite>` is maintained by mutation sites. Watcher callback checks `ignoreSet.has(absPath)`:

- Path absent → reconcile (external edit).
- Path present, file's current mtime equals recorded mtime → skip (our own write).
- Path present, current mtime differs → fall through to reconcile (external edit collided with our write window).

Entries are released after a grace window post-fsync (`stabilityThreshold + 200ms` = 500ms default).

Rejected alternatives: hash coalesce (parses every internal write — wasteful), naive mtime stamp (collisions on FS with 1ms granularity), unwatch/rewatch (chokidar internal cost; missed external events during window).

### D3. Debounce = chokidar `awaitWriteFinish` (Q3 / A)

```
{ stabilityThreshold: 300, pollInterval: 100 }
```

chokidar's built-in stable-write detection. Coalesces Obsidian autosave bursts and editor-flush bursts into one `change` event per logical edit. Latency floor of 300ms post-edit until reindex; acceptable for human-edit path. Internal writes skipped via D2 — `awaitWriteFinish` only matters for external edits.

### D4. Per-event handling

| chokidar event                                  | Action                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`                                           | Parse → if id resolves: embed → `vectorIndex.upsert` → `vaultIndex.register(id, entry)` + clear any `unindexable` for path; else: `vaultIndex.setUnindexable(path, reason)`                                                                                   |
| `change`                                        | Parse → compare body hash to lance `content_hash`. Hash matches: only `vectorIndex.upsertMetaOnly` if frontmatter changed (else `skipped`). Hash differs: full re-embed + `vectorIndex.upsert`. Always: resolve any open `parse_error` flag for the memory id |
| `unlink`                                        | `vaultIndex` reverse-lookup absPath → memoryId. If found: `vectorIndex` soft-archive (`archived = true` flip per memory `GKep85Rl4NGJbnTScVXNz`) → `vaultIndex.unregister(id)` → resolve any open `parse_error` flag for that id                              |
| `unlinkDir`                                     | Iterate `vaultIndex.entries()` under prefix → apply unlink action per entry                                                                                                                                                                                   |
| `addDir` / `ready`                              | No-op (initial scan handled by `runBootScan`)                                                                                                                                                                                                                 |
| Parse failure on any event, file already in idx | `flagService.createFlag(memoryId, "parse_error", reason)` if no open one exists (Phase 4d producer logic)                                                                                                                                                     |
| Parse failure, file NOT in idx                  | `vaultIndex.setUnindexable(path, reason)` — surfaces in `BackendSessionStartMeta.parse_errors` next sessionStart                                                                                                                                              |
| Parse pass on previously-flagged file           | Auto-resolve any open `parse_error` flag for the memory id (Phase 4d auto-resolution semantic)                                                                                                                                                                |
| Parse pass on previously-unindexable path       | `vaultIndex.clearUnindexable(path)` — file recovered                                                                                                                                                                                                          |

### D5. Boot reconcile = explicit pre-listen scan (Q5 / B)

`runBootScan` iterates `listMarkdownFiles(vaultRoot)`, calls `reconcileFile(path, "add")` per file, then queries lance for paths-not-on-disk and archives them. `httpServer.listen()` does not run until the scan completes.

chokidar starts after the scan with `ignoreInitial: true` — only live events trigger callbacks.

Reasoning: explicit phase boundary makes HTTP readiness clear. Otherwise the first request after restart could read stale lance results. Orphan detection (lance row whose path no longer exists on disk) is trivial in an explicit scan; would require a separate post-`ready` sweep with `ignoreInitial: false`. The Phase 4d `parse_error` startup-scan is just a special case of the boot reconcile and folds in naturally.

### D6. Module boundary = three modules (approach 3)

```
src/backend/vault/watcher/
├── reconciler.ts     # pure-ish: reconcileFile(absPath, signal) + archiveOrphans
├── watcher.ts        # chokidar wrapper + ignore set
├── boot-scan.ts      # walks vault, calls reconciler, archives orphans
└── types.ts          # WatcherSignal, ReconcileResult, IgnoreSet
```

Reconciler depends on parser, memoryRepo, vectorIndex, flagRepo. Does NOT depend on chokidar. Watcher depends on chokidar + reconciler. Boot scan depends on reconciler + `listMarkdownFiles`.

Reasoning: separation of concerns — chokidar wiring (watcher) vs business logic (reconciler). Reconciler is reusable for boot-scan and live-event paths. Unit tests don't touch chokidar; matches Phase 4d pattern of separating producer logic from invocation site.

### D7. Test strategy = tiered, four tiers (Q6 / D)

- **T1 reconciler unit tests** (synchronous, mock deps) — cover all per-event branches in D4 + parse failures + lance failures + orphan archive.
- **T2 watcher unit tests** (mock chokidar via EventEmitter stub) — cover ignoreSet semantics, mtime-tuple R2 case, error-event handling, shutdown-awaits-in-flight.
- **T3 boot-scan unit tests** (real fs tmpdir, stub reconciler) — cover counts, parse failures during scan, lance orphan detection.
- **T4 E2E smoke** (real chokidar + real backend + tmpdir) — five cases only; PR-only with `--testTimeout=10000`.

Tier 5 (existing contract tests) unchanged; watcher is additive. Optionally extend `users-gitignore-invariant.test.ts` to assert watcher does not surface user-scope content in `parse_error` flag reasons or unindexable entries.

## Architecture

### Module layout

```
src/backend/vault/watcher/
├── reconciler.ts
├── watcher.ts
├── boot-scan.ts
└── types.ts
```

### Component interfaces

```ts
// types.ts
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
  add(absPath: string, mtimeAfterWrite: number): void;
  has(absPath: string, currentMtime: number): boolean; // returns true only if path tracked AND mtime matches
  releaseAfter(absPath: string, graceMs: number): void;
}
```

```ts
// reconciler.ts
export interface Reconciler {
  reconcileFile(
    absPath: string,
    signal: ReconcileSignal,
  ): Promise<ReconcileResult>;
  archiveOrphans(
    diskPaths: ReadonlySet<string>,
  ): Promise<{ archived: string[] }>;
}

export function createReconciler(deps: {
  vaultIndex: VaultIndex; // path/id map + unindexable list
  vectorIndex: VaultVectorIndex; // lance upsert/softArchive/upsertMetaOnly + content_hash compare
  flagService: FlagService; // createFlag / resolveFlag / hasOpenFlag for parse_error
  embed: Embedder; // (text) => Promise<number[]>; same provider VaultBackend uses
  vaultRoot: string;
}): Reconciler;
```

```ts
// watcher.ts
export interface VaultWatcher {
  start(): Promise<void>; // resolves on chokidar 'ready'
  stop(): Promise<void>; // chokidar.close(); awaits in-flight reconciles
  ignoreSet: IgnoreSet;
}

export function createVaultWatcher(opts: {
  vaultRoot: string;
  reconciler: Reconciler;
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number }; // default 300/100
  graceMs?: number; // default 500ms
}): VaultWatcher;
```

```ts
// boot-scan.ts
export async function runBootScan(opts: {
  vaultRoot: string;
  reconciler: Reconciler;
}): Promise<{
  scanned: number;
  reconciled: number;
  orphaned: number;
  parseErrors: number;
  embedErrors: number;
}>;
```

### Wiring in `VaultBackend.create()`

`VaultBackend.create()` is already the async lifecycle entry point in `src/backend/vault/index.ts`. Boot scan + watcher start fold into it; `httpServer.listen()` (in `src/server.ts`) only runs after `create()` resolves, so the gate is satisfied naturally.

```
VaultBackend.create():
  1. ensureVaultGit()                          # existing
  2. ensureRemote() → reconcileDirty() → alignWithRemote()  # existing (Phase 4b)
  3. VaultVectorIndex.create()                 # existing
  4. VaultIndex.create()                       # existing
  5. VaultMemoryRepository.create()            # existing
  6. runBootScan(reconciler, vaultIndex, vectorIndex)  # new — blocks until consistent
  7. createVaultWatcher(...).start()           # new — resolves on chokidar 'ready'
  8. return new VaultBackend(...)              # caller (server.ts) then listen()s
```

`VaultBackend` gains a `vaultWatcher: VaultWatcher` private field. `close()` adds `await this.vaultWatcher.stop()` BEFORE `pushQueue.close()` (watcher might enqueue commits via reconciler-triggered writes; drain pushQueue last).

### Mutation-site changes

- `VaultMemoryFiles.edit` (`src/backend/vault/repositories/memory-files.ts`) — accept optional `ignoreSet: IgnoreSet` ctor param. Post-fsync inside `edit()`: read mtime of written file, call `ignoreSet.add(absPath, mtime)`, schedule `ignoreSet.releaseAfter(absPath, 500)` after the commit completes.
- `VaultMemoryRepository` write paths (`create`, `update`, `archive`, `verify`) — same `ignoreSet` plumbing for the markdown write step. Optional ctor param defaulting to `NoopIgnoreSet`. No new public methods needed — reconciler uses `VaultIndex` directly (`register` / `unregister` / `entries` / `setUnindexable` / `clearUnindexable` already exist).
- Reverse path → id lookup for `unlink` events: iterate `vaultIndex.entries()` matching `entry.path === relPath`. O(N) but small N at vault scale; avoids new index. If profiling shows hotspot, add a reverse map later.
- `GitOpsImpl.stageAndCommit` callers — no direct change; commits update markdown mtime which is captured at `edit()` post-fsync.
- `src/backend/types.ts` — extend `BackendSessionStartMeta` with `watcher_error?: true` (literal-`true` presence-only convention per memory `bONZKfXKa_cv4a2s0I2NV`).
- `package.json` — add `chokidar` dependency (not currently listed; need explicit add).

## Data flow

### Boot path

```
VaultBackend.create()
  ├─ ensureVaultGit()
  ├─ ensureRemote() → reconcileDirty() → alignWithRemote()
  ├─ VaultVectorIndex.create() / VaultIndex.create() / VaultMemoryRepository.create()
  ├─ runBootScan()
  │    ├─ listMarkdownFiles(vaultRoot) → diskPaths
  │    ├─ for each path:
  │    │     reconciler.reconcileFile(path, "add")
  │    │       ├─ parser.parse(content)
  │    │       │     ├─ ok    → diff lance content_hash
  │    │       │     │           ├─ no row     → embed + lance.upsert + vaultIndex.register + flagService.resolve(open parse_error flags)
  │    │       │     │           ├─ hash same  → if frontmatter changed → lance.upsertMetaOnly; else skipped. flagService.resolve(open parse_error flags)
  │    │       │     │           └─ hash diff  → embed + lance.upsert + flagService.resolve(open parse_error flags)
  │    │       │     └─ fail  → if id-in-vaultIndex: flagService.createFlag(id, "parse_error", reason); else: vaultIndex.setUnindexable(path, reason)
  │    └─ reconciler.archiveOrphans(diskPaths)
  │          └─ lance.scan archived=false → for each row: if row.path ∉ diskPaths → lance.update {archived:true} + vaultIndex.unregister(id)
  ├─ watcher.start()                  # chokidar watch + ready
  └─ return new VaultBackend(...)     # caller does httpServer.listen()
```

### Live path (post-`ready`)

```
External edit (Obsidian save / git pull checkout / vim write)
  → chokidar event (after awaitWriteFinish stabilizes)
  → watcher dispatches:
       fs.stat absPath → currentMtime
       if ignoreSet.has(absPath, currentMtime): return    # internal write, skip
       reconciler.reconcileFile(absPath, signal)
         add/change → same logic as boot path
         unlink    → memoryId = vaultIndex reverse-lookup of absPath (iterate entries)
                     if found: lance.update {archived:true} + vaultIndex.unregister(id) + flagService.resolve(open parse_error flags)
                     if not:  vaultIndex.clearUnindexable(path) (in case it was unindexable) → no-op otherwise
```

### Internal write path (existing tools, augmented)

```
memory_create / memory_update / memory_archive
  → MemoryService → VaultMemoryRepository / VaultMemoryFiles.edit
  → withFileLock + write markdown
  → fs.stat → mtime
  → ignoreSet.add(absPath, mtime)
  → commit + lance write
  → ignoreSet.releaseAfter(absPath, 500ms)
  → response returns
  → chokidar fires change event ~50-300ms later (awaitWriteFinish stable)
  → watcher checks ignoreSet → mtime matches → skip
```

### Critical invariants

- Boot scan completes before any external client can hit the server.
- `graceMs` ≥ `awaitWriteFinish.stabilityThreshold`; 500ms vs 300ms = 200ms safety margin.
- Reconcile is idempotent: hash-skip means duplicate events are cheap (parse + hash compare, no embed, no lance write).

## Race & coordination

- **R1. Internal write vs watcher.** Solved by ignoreSet (D2) + grace window outlasting `stabilityThreshold`.
- **R2. Concurrent external edit during internal write.** External overwrites internal between fsync and grace expiry. Mitigation: ignoreSet uses `(absPath, mtimeAfterWrite)` tuple; `has()` compares current mtime; mismatch → fall through to reconcile.
- **R3. Boot scan vs incoming external edit.** Boot scan runs pre-listen; chokidar not yet started. External edits during boot-scan window are picked up once chokidar starts (subsequent `change` event with later mtime). Acceptable.
- **R4. Watcher vs `git pull` mid-pull.** Pull does N file ops → N chokidar events → each goes through `awaitWriteFinish` → idempotent reconcile. Push-queue mutex (Phase 4b) prevents pull-during-write.
- **R5. Reconciler concurrency.** Multiple `reconcileFile` invocations interleave; each acquires `VaultMemoryFiles` lock per path → per-file serial, cross-file parallel. Lance ops independent across rows. Safe.
- **R6. Watcher vs shutdown.** `VaultBackend.stop()`: `watcher.stop()` (chokidar.close, awaits in-flight callbacks) → `pushQueue.drain()` → done.

## Error handling

- **E1. Parse failure during reconcile.** Reconciler catches parse errors only (raw `Error` from `parseMemoryFile`). Two branches: (a) memoryId resolvable from prior parse → `flagService.createFlag(id, "parse_error", reason)` if no open one exists; idempotency via Phase 4d duplicate-flag guard. (b) memoryId NOT resolvable (frontmatter completely broken) → `vaultIndex.setUnindexable(path, reason)`; surfaces via `BackendSessionStartMeta.parse_errors` on next `sessionStart`. Returns `{action: "parse-error"}`. Other thrown errors (EACCES, EIO) → `logger.error` + rethrow; watcher catches at dispatch + logs; does NOT crash watcher. Boot scan accumulates count → reported in return.
- **E2. Lance write failure during reconcile.** Markdown is source of truth (memory `GKep85Rl4NGJbnTScVXNz`). Lance failure → `logger.error` + result `{action: "skipped", reason: "lance-failure"}`. In-memory index NOT updated. Next chokidar event on same path retries; if file unchanged, no event → drift persists until next process boot via `runBootScan`. Live drift recovery deferred (Phase 8 perf+reliability).
- **E3. Embed call failure (Ollama down).** Same as E2: log + skip. Boot scan does NOT block startup on embed failure — log + skip + continue. Boot return reports `embedErrors: N`. HTTP comes up; affected memories searchable but with stale embeddings. Acceptable degradation.
- **E4. chokidar internal error.** chokidar's `error` event → `logger.error`. Do NOT auto-restart watcher (silent failure risk). Surface via `BackendSessionStartMeta.watcher_error?: true`.
- **E5. Flag write failure during parse_error path.** `flagService.createFlag` throws (disk full / pg failure on shared envelope). Log + continue reconcile. parse_error visibility lost for that file until next reconcile attempt. No cascade.
- **E6. ignoreSet false negative.** Watcher reconciles a file we just wrote. Cost: one wasted parse + hash compare → hash matches lance → `skipped`. Idempotent, low cost.
- **E7. ignoreSet false positive.** External edit lands during ignoreSet window with mtime != recorded. R2 mtime tuple catches → fall through to reconcile.

## Testing

### T1 — Reconciler unit tests

`tests/unit/backend/vault/watcher/reconciler.test.ts`. Mock deps (parser real; memoryRepo, vectorIndex, flagRepo as in-memory stubs).

- `add`: new file → embed + index + flag-archive
- `change`: hash same + frontmatter same → `skipped`
- `change`: hash same + frontmatter diff → `meta-updated`
- `change`: hash diff → `reembedded`
- `unlink`: existing → `archived` + index remove
- `unlink`: unknown path → no-op
- parse fail with id resolvable → `flagService.createFlag` called (mock asserts) + result `parse-error`
- parse fail with id NOT resolvable → `vaultIndex.setUnindexable` called + result `parse-error`
- parse pass on previously-flagged file → `flagService.resolveFlag` called for each open `parse_error` flag
- `archiveOrphans`: lance has 3 rows, disk has 2 paths → 1 archived
- lance failure during upsert → `skipped/lance-failure`, no index mutation

### T2 — Watcher unit tests

`tests/unit/backend/vault/watcher/watcher.test.ts`. Mock chokidar via `EventEmitter` stub. Real reconciler with stubbed deps.

- emit `add` → reconciler called with signal `"add"`
- ignoreSet.has(path) with matching mtime → reconciler NOT called
- ignoreSet.has(path) but current mtime != recorded → reconciler IS called (R2)
- `releaseAfter` clears entry after grace
- chokidar `error` event → logger + does not throw; sets `watcher_error` meta flag
- `stop()` awaits in-flight reconcile

### T3 — Boot-scan unit tests

`tests/unit/backend/vault/watcher/boot-scan.test.ts`. Real fs (tmpdir), stub reconciler.

- empty vault → counts all zero
- 5 files all parse → 5 reconcile calls
- 3 files parse + 1 fails + 1 already-indexed → counts correct
- 2 lance orphans → `archiveOrphans` called

### T4 — E2E smoke

`tests/integration/vault-watcher-e2e.test.ts`. Real chokidar + tmpdir + real `VaultBackend` (lance + git). PR-only, `--testTimeout=10000`. Five cases only:

1. External `writeFile` of new memory → `memory_search` returns it within 1s
2. External edit of existing memory body → re-embedded; search relevance changes
3. External `rm` → `memory_search` excludes
4. Internal `memory_create` does NOT cause double-reindex (assert lance row written count == 1)
5. Boot scan + watcher composition: kill backend mid-edit, restart, assert state converges

### T5 — Existing contract tests

Unchanged. Optionally extend `tests/contract/repositories/users-gitignore-invariant.test.ts` to assert watcher does not surface user-scope content in flag reasons or unindexable entries.

## Non-Goals

- Watcher-driven incremental git commit of external edits. External edits stay uncommitted in working tree; user runs git themselves. Potential Phase 6 work.
- HNSW / IvfPq tuning (Phase 8).
- Reverse migration vault→pg (Phase 6).
- Rename detection. chokidar `add`+`unlink` pair handled as archive+new, not move. Filename = title since commit `2fb21f1`, so renames carry semantic meaning; deferred until demand surfaces.
- Multi-vault per server. One watcher per `VaultBackend` instance.

## Plan-time deferrals

These are implementation-level choices, intentionally left for `writing-plans`:

- Exact chokidar option set beyond `awaitWriteFinish` + `ignoreInitial` (`atomic`, `followSymlinks`, etc.).
- Logger field shape for watcher events.
- Whether `runBootScan` parallelizes file processing (likely sequential at small scale; revisit at >1000 memories).
- Reconciler API for soft-archive: direct `lance.update` call vs delegating to `vectorIndex.softArchive(memoryId)` helper. Lean toward helper.
- Concrete `graceMs` + `awaitWriteFinish` constants — exposed via `VaultBackendConfig` for test override.
- Whether tier 4 E2E uses `vitest.config.ts` test name pattern or separate vitest project.

## Open questions

None blocking implementation. All architectural choices locked above.
