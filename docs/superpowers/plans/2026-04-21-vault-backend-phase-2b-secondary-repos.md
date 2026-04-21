# Vault Backend Phase 2b — Secondary Repositories

**Goal:** Land the six remaining StorageBackend repository interfaces on the vault backend so `createBackend({ backend: "vault" })` can hand back a complete `StorageBackend`. Phase 2a shipped `VaultMemoryRepository` + `VaultWorkspaceRepository`; Phase 2b covers everything else plus the backend-level wiring.

**Approach:** Split into three sub-phases to keep PRs reviewable and unblock dependents incrementally.

| Sub-phase | Scope                                                                                      | Storage style                                | Depends on                         |
| --------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------- |
| **2b.1**  | AuditRepository · SchedulerStateRepository · SessionTrackingRepository · SessionRepository | Standalone JSON files under the vault root   | Phase 2a IO primitives only        |
| **2b.2**  | CommentRepository · FlagRepository · RelationshipRepository                                | Embedded in the hosting memory markdown file | 2b.1 + shared id→path index access |
| **2b.3**  | `VaultBackend` class · factory registration · integration contract tests                   | Composes 2a + 2b.1 + 2b.2                    | 2b.1 and 2b.2                      |

---

## 2b.1 — Standalone repositories (this plan)

The four "standalone" repos don't mutate memory markdown files — they keep their own state under a dedicated directory in the vault root. JSON over markdown: these are internal records, not user-editable, and don't benefit from Obsidian rendering.

### Storage layout

```
<vault-root>/
├── _audit/<memory_id>.jsonl        # append-only, one JSON entry per line
├── _scheduler-state.json           # { [job_name]: ISO timestamp }
├── _sessions/<session_id>.json     # { id, user_id, project_id, workspace_id, budget_used }
└── _session-tracking/<user>/<workspace>/<project>.json   # { last_session_at }
```

All under `_`-prefixed paths so they never collide with the three memory-layout directories (`workspaces/`, `project/`, `users/`) consumed by `inferScopeFromPath`. The indexer in Phase 2a already skips non-memory files — verify with a test.

### VaultAuditRepository

Interface:

```ts
create(entry: AuditEntry): Promise<void>;
findByMemoryId(memoryId: string): Promise<AuditEntry[]>;
```

- `create` appends one line to `_audit/<memory_id>.jsonl` under `withFileLock`.
- `findByMemoryId` reads the file, splits on `\n`, JSON-parses each non-empty line, re-hydrates `created_at` via `new Date(...)` with `Number.isNaN` guard, sorts `created_at` desc.
- Missing file → empty array (ENOENT).

### VaultSchedulerStateRepository

Interface:

```ts
getLastRun(jobName): Promise<Date | null>;
recordRun(jobName, runAt): Promise<void>;
```

- Single JSON file `_scheduler-state.json` keyed by job name.
- `recordRun` is **monotonic** — matches pg `setWhere lt(last_run_at, runAt)`. Under file lock, read current value, only write if `runAt > current`.
- Missing file → empty map on read; written lazily.

### VaultSessionTrackingRepository

Interface:

```ts
upsert(userId, projectId, workspaceId): Promise<Date | null>;
```

- One JSON file per composite key: `_session-tracking/<user_id>/<workspace_id>/<project_id>.json`.
- Under lock: read existing `last_session_at` (null if missing), write new `last_session_at = now()`, return the previous value.
- Path segments sanitized via `safeSegment` (reuse `io/paths.ts` helper).

### VaultSessionRepository

Interface:

```ts
createSession(id, userId, projectId, workspaceId): Promise<void>;
getBudget(sessionId): Promise<{used, limit} | null>;
incrementBudgetUsed(sessionId, limit): Promise<{used, exceeded}>;
findById(sessionId): Promise<{...} | null>;
```

- File per session: `_sessions/<session_id>.json`.
- `createSession`: write via `writeJsonExclusive` (O_EXCL). Concurrent same-id creates: exactly one winner; the loser's EEXIST is translated to `session already exists: <id>`. Mirrors pg's PK constraint semantics.
- `incrementBudgetUsed`: under lock, read, if `budget_used < limit` increment and write, else return `exceeded: true`. Mirrors pg atomic CAS semantics.
- `findById` / `getBudget`: plain reads; ENOENT → null.

### Shared helpers

Add to `src/backend/vault/io/`:

- `json-fs.ts`: `readJson<T>(root, rel): Promise<T | null>` (ENOENT or empty file → null), `writeJsonAtomic(root, rel, obj)` (tmp + rename, atomic vs. concurrent readers), `writeJsonExclusive(root, rel, obj)` (O_EXCL write, throws `EEXIST` on collision — used by `createSession`), `appendJsonLine(root, rel, value)` (under lock), `readJsonLines<T>(root, rel): Promise<T[]>` (skips a partial trailing line as crashed-writer debris; middle-of-file malformed lines throw).
- `safeSegment` / `UNSAFE_SEGMENT` are exported from `io/paths.ts` and reused by all four repos.

### Tests

- **Contract tests** (`tests/contract/repositories/`): parameterize over pg + vault factories. Each repo gets its own file mirroring the Phase 2a pattern. Factories extend `TestBackend` with the new repos.
- **Unit tests** (`tests/unit/backend/vault/repositories/`): per-repo edge cases — monotonic regression for scheduler, concurrent `incrementBudgetUsed` races for session, append-only ordering for audit, composite-key path sanitization for session tracking.

### Task breakdown

- [x] Task 1 — `io/json-fs.ts` + unit tests
- [x] Task 2 — `VaultAuditRepository` + unit tests + contract test
- [x] Task 3 — `VaultSchedulerStateRepository` + unit tests + contract test
- [x] Task 4 — `VaultSessionTrackingRepository` + unit tests + contract test
- [x] Task 5 — `VaultSessionRepository` + unit tests + contract test
- [x] Task 6 — Verify Phase 2a `inferScopeFromPath` still returns `null` for `_audit/` / `_scheduler-state.json` / `_sessions/` / `_session-tracking/` paths (tested via parseIso + `inferScopeFromPath` unit tests — `_`-prefixed segments never match the three memory layouts)
- [x] Task 7 — typecheck + lint + prettier + full test suite green

---

## 2b.2 — Embedded repositories (follow-up plan)

`CommentRepository`, `FlagRepository`, `RelationshipRepository` all persist inside the owning memory's markdown file. They need:

1. Access to the `id → path` index maintained by `VaultMemoryRepository` (or rebuild their own on construction).
2. Read-modify-write of the hosting markdown file under the file lock, including re-serializing the full memory + sections.
3. Parity with pg side-effects — e.g. `CommentRepository.create` bumps `last_comment_at` + `updated_at` on the parent memory (but not `version`); `FlagRepository.autoResolveByMemoryId` sets `resolved_at: now()` on all matching flags.

**Design question to resolve at 2b.2 start:** whether the three embedded repos share a single "MemoryFileEditor" service (holding the index + lock coordination) or each walks the vault independently. Separate repos with a shared reader is probably cleaner and avoids singleton coupling.

Cross-memory query on vault: `FlagRepository.findOpenByWorkspace` and `RelationshipRepository.findBetweenMemories` need to scan multiple memory files. Acceptable at Phase 2 scale (`#loadAll` already does this for listings); document the O(N) cost.

---

## 2b.3 — Backend wiring (follow-up plan)

- `src/backend/vault/index.ts` — `VaultBackend` class composing all eight repos; `close()` releases anything that needs releasing (likely nothing, since all IO is per-op).
- `src/backend/factory.ts` — switch the `vault` arm to `VaultBackend.create({ root })` instead of throwing.
- `src/backend/vault/config.ts` — resolve vault root from env/config.
- Integration contract tests: add `backendFactory` suite that instantiates a full `VaultBackend` and runs a small cross-repo scenario (create memory → add comment → flag → resolve flag).
- Update `README.md` / env docs if needed.

---

## Out of scope (deferred)

- LanceDB / embedding store (Phase 3 — Memory vector methods remain `NotImplementedError`).
- Git commit / push / pull (Phase 4).
- `users/` gitignore guidance (Phase 4).
- Chokidar file watcher (Phase 5).
- Migration CLI (Phase 6).
