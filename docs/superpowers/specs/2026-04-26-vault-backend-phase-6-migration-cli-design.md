# Vault Backend Phase 6 — Bidirectional Migration CLI

**Status:** Design proposed 2026-04-26. Pending user approval before implementation plan.

**Roadmap source:** `docs/superpowers/specs/2026-04-21-vault-backend-design.md` line 459 — "Migration CLI + reverse migration."

**Predecessor phases:** 0 (interface extraction), 1 (parser), 2a/2b (repos), 3 (lance vector index), 4a–4d (git write path / push queue / audit + merge / parse-error flags), 5 (#TBD chokidar watcher + boot reconcile). Main is clean baseline as of latest Phase 5 merge.

## Goals

1. **pg → vault migration.** Read every entity (memories, comments, flags, relationships, workspaces) from PostgresBackend and write to VaultBackend so the resulting vault round-trips through the existing repo contract tests.
2. **vault → pg migration.** Symmetric reverse path. Drains the vault into a freshly-empty pg schema. Used for parity validation per design §428–429 and as a safety valve for users rolling back vault adoption.
3. **One source of truth for serialization.** Reuse `StorageBackend` repository methods on the destination side; do not duplicate parser/serializer or SQL insert logic in CLI scripts.
4. **Idempotent re-run.** A failed migration can be re-run from zero without manual cleanup as long as the documented preconditions still hold (empty pg target for vault→pg; fresh or upserted vault for pg→vault).
5. **Embedding fidelity by default.** Carry vectors over directly when source/dest dim match; fail fast on mismatch unless user opts into `--reembed`.

Non-goals: see "Non-Goals" section.

## Non-Goals

- Resumable / partial-state recovery. One-shot only.
- Live concurrent server use during migration. The HTTP server must be stopped first; CLI does not coordinate with a running process.
- Per-scope filtering flags (`--scope=workspace,project,...`). Migrates every scope present in source.
- Schema migration of the pg target. CLI verifies drizzle migrations are current; aborts otherwise with a remediation hint.
- MCP-tool invocation surface. Migration is a maintenance operation, not an in-band tool call.
- Archived-memory exclusion. Archived rows migrate identically to live ones; archive metadata is preserved.
- User-scope re-routing or filtering. Whatever scope a memory has in source is what it has in dest. `users/` privacy invariant on the vault side is upheld by the existing write path.

## Decisions

### D1. Scope = both directions, single phase (Q1 / A)

`pg→vault` and `vault→pg` ship together. Reasoning: roadmap row 6 lists both; reverse migration is needed by the parity E2E in §428–429 of the master design; building only one direction now would re-touch the same module structure later.

### D2. Invocation = standalone CLI scripts (Q2 / A)

Two entry points under `src/cli/`:

```
src/cli/migrate-pg-to-vault.ts
src/cli/migrate-vault-to-pg.ts
```

Each compiles to `dist/cli/migrate-*.js`, exposed via npm scripts:

```json
"scripts": {
  "migrate:pg-to-vault": "node dist/cli/migrate-pg-to-vault.js",
  "migrate:vault-to-pg": "node dist/cli/migrate-vault-to-pg.js"
}
```

Reasoning: matches existing `src/cli/merge-memory.ts` shape. Migration is offline by nature (server stopped). Minimal harness — no dispatcher binary required for two operations. Future unification under an `agent-brain` CLI can subsume these without API change.

Rejected: MCP tool surface (live writes during migration = data race); single dispatcher binary (unjustified complexity for two scripts).

### D3. Run model = one-shot, idempotent (Q3 / A)

Each invocation runs to completion or fails. Failure leaves the destination in whatever partial state the writes reached. Re-run is safe because:

- pg→vault: same memory id resolves to same vault path; `writeAtomic` overwrites; lance `upsert` keys on id.
- vault→pg: precondition is empty target. After a partial run, user TRUNCATEs and re-runs.

No state file, no resume cursor. Justified by expected scale (low thousands of memories, minutes of runtime) and the preconditions on each side.

### D4. Embeddings = carry-over by default, `--reembed` flag, dim guard (Q4 / C)

**pg → vault:**

1. Read `embedding_dimensions` from `EmbeddingProvider` config and pgvector column dim from `information_schema`.
2. Read vault target's lance schema dim (existing field on `VaultVectorIndex`).
3. If `--reembed` flag passed: ignore source vectors; call current `EmbeddingProvider.embed(content)` per memory.
4. Otherwise: source dim must equal dest dim; mismatch aborts with remediation hint ("re-run with `--reembed`").

**vault → pg:** symmetric. Source = lance dim, dest = pgvector column dim.

Implementation note: `MemoryRepository.create` currently embeds inside the call. Migration mode must accept a pre-computed embedding to avoid re-embedding when carrying over. Either expose an embedder-bypass on the repo (`{ embedding: number[] }` option) or have the CLI take a private fast-path that calls the underlying writers directly with the embedding. See D8 for the resolution.

### D5. Git commit shape on pg→vault = single bulk commit (Q5 / A)

CLI bypasses per-write commits by constructing the destination `VaultBackend` with `{ skipCommit: true, skipPush: true }`. After all writes complete:

1. CLI calls `git add -A` against the vault root.
2. CLI commits with trailers:
   ```
   AB-Action: migration
   AB-Source: pg
   AB-Count: <N>
   AB-Actor: <git config user.email>
   ```
3. CLI flushes the push queue once (single `pushQueue.request()` + drain) so the freshly-bulk-committed state pushes in one round.

Reasoning: migration is a single logical event; commit-per-memory in the normal flow exists because each is a separate user action. One commit = clean audit log row, fast push, no thousands-of-objects bandwidth surge.

### D6. vault→pg precondition = empty target (Q6 / A)

CLI runs:

```sql
SELECT count(*) FROM memories LIMIT 1;
```

Non-zero → abort with remediation:

```
Target database not empty (memories table has rows).
To proceed: TRUNCATE the agent-brain tables in the target schema, or
point AGENT_BRAIN_DATABASE_URL at a fresh database, then re-run.
```

Drizzle migration check:

```
SELECT MAX(created_at) FROM drizzle.__drizzle_migrations;
```

Compares latest applied migration against the build's compiled migrations list. Mismatch → abort with `npm run db:migrate` hint.

Reasoning: silent TRUNCATE is dangerous; one-extra-step remediation is zero ambiguity. The `--mode=fresh|merge` flag was rejected for the same reason (a flag that nukes user data must not exist).

### D7. Verify = counts-only (Q7 / B)

After write phase, CLI compares per-entity counts:

```
memories      <src>  vs  <dst>
comments      <src>  vs  <dst>
flags         <src>  vs  <dst>
relationships <src>  vs  <dst>
workspaces    <src>  vs  <dst>
```

Mismatch on any row → exit code 2, log the offending kind. Match on all → exit code 0.

Reasoning: catches whole-row drops cheaply (most likely silent failure mode). Deep parity is what the E2E test in §428–429 covers; that test belongs in `tests/e2e/`, not in a verify flag that runs every migration.

### D8. Write path = reuse repos with migration-mode flag (Q8 / A)

Add `MigrationMode` option to `VaultBackendConfig` and to repo ctors that participate in the git path:

```ts
export interface VaultBackendConfig {
  // ...existing fields...
  migrationMode?: { skipCommit: true; skipPush: true };
}
```

When present:

- `gitOps.commit` calls become no-ops (or short-circuit before stage).
- `pushQueue.request` is replaced by a no-op stub.
- File locks are still acquired (cheap; protects against test race).
- Atomic rename still used.
- Lance writes still happen normally.
- Watcher is **not** started (CLI runs `VaultBackend.create({ ...migrationMode, skipWatcher: true })`).
- Boot scan is **not** run (vault is being constructed; no pre-existing index to reconcile).

PostgresBackend has no equivalent flag because per-row inserts are the whole point of its write path; nothing to disable.

For the embedding-carry-over fast path, expose an internal write method on `VaultMemoryRepository` (and `PostgresMemoryRepository`) that takes a pre-computed embedding instead of running the embedder:

```ts
// internal — not on the public MemoryRepository interface
createWithEmbedding(memory: NewMemory, embedding: number[]): Promise<Memory>;
```

CLI calls this when not in `--reembed` mode. Normal path (`MemoryRepository.create`) is unchanged.

## Architecture

### Module layout

```
src/cli/
├── migrate-pg-to-vault.ts        # CLI entry point
├── migrate-vault-to-pg.ts        # CLI entry point
└── migrate/
    ├── pg-to-vault.ts            # core: streams pg rows → vault repos
    ├── vault-to-pg.ts            # core: streams vault rows → pg repos
    ├── preflight.ts              # dim check, target-empty check, drizzle check
    ├── verify.ts                 # counts-only verify
    └── types.ts                  # MigrationOptions, MigrationReport
```

The `migrate/` subdir holds the substance; the two CLI files are thin argv parsers + DI wiring + exit-code mapping.

### Migration-mode plumbing

Three changes outside the new files:

1. **`src/backend/vault/index.ts`** — `VaultBackendConfig` gains `migrationMode?` and `skipWatcher?`. `VaultBackend.create` threads the flag into `GitOpsImpl`/`PushQueue`/repo ctors. Default behavior unchanged.
2. **`src/backend/vault/git/git-ops.ts`** — `commit()` becomes a guarded no-op when migration mode is on.
3. **`src/backend/vault/git/push-queue.ts`** — exported factory accepts `{ disabled: true }` returning a stub with `request()` and `drain()` no-ops.

Repo ctors do **not** branch on migration mode directly; they receive an already-configured `gitOps` and `pushQueue`. This keeps the migration concern at the wiring layer.

### Data flow — pg → vault

```
parse argv:
  --vault-root, --pg-url, --reembed, --verify (default true), --dry-run
preflight:
  1. instantiate read-only PostgresBackend (or raw drizzle client)
  2. instantiate VaultBackend with { migrationMode, skipWatcher: true }
  3. dim check: pg embedding_dimensions vs vault lance dim
       --reembed bypasses the equality check
  4. log run plan: counts per kind from pg

dry-run gate: if --dry-run, exit 0 here.

write phase (in this order):
  1. workspaces
  2. memories (with embedding carry-over or re-embed)
  3. comments
  4. flags
  5. relationships

bulk-commit phase:
  git add -A
  git commit -m 'migration: pg → vault' --trailers AB-*

verify phase:
  pgCounts vs vaultCounts; mismatch → exit 2.

push phase:
  pushQueue.request() once; drain; exit code from push outcome.
```

Order matters: workspaces before memories (FK), memories before comments/flags/relationships (FK).

### Data flow — vault → pg

```
parse argv:
  --vault-root, --pg-url, --reembed, --verify (default true), --dry-run
preflight:
  1. instantiate read-only VaultBackend (skipWatcher: true, migrationMode for symmetry)
  2. instantiate PostgresBackend
  3. target-empty check (count(*) on memories table)
  4. drizzle migrations current on target
  5. dim check: vault lance dim vs pg embedding_dimensions
       --reembed bypasses

dry-run gate: if --dry-run, exit 0 here.

write phase (same FK order as pg→vault):
  1. workspaces
  2. memories
  3. comments
  4. flags
  5. relationships

verify phase:
  vaultCounts vs pgCounts; mismatch → exit 2.
```

No bulk-commit phase on this direction; pg has no commit concept. PostgresBackend writes inside transactions per repo call as today.

### Streaming vs in-memory

For low-thousands scale, a single `await` over all rows per kind is acceptable RAM. For scale headroom, both readers expose async iterators (`for await (const batch of repo.streamAll({ batchSize: 500 }))`). Phase 6 ships in-memory reads; streaming is a YAGNI deferred to a follow-up if vault sizes warrant it.

### CLI surface

```
$ node dist/cli/migrate-pg-to-vault.js \
    --vault-root /path/to/vault \
    --pg-url postgres://... \
    [--reembed] \
    [--no-verify] \
    [--dry-run]

$ node dist/cli/migrate-vault-to-pg.js \
    --vault-root /path/to/vault \
    --pg-url postgres://... \
    [--reembed] \
    [--no-verify] \
    [--dry-run]
```

Required flags read from env when omitted: `AGENT_BRAIN_VAULT_ROOT`, `AGENT_BRAIN_DATABASE_URL`, `AGENT_BRAIN_EMBEDDING_DIMENSIONS`, `AGENT_BRAIN_PROJECT_ID`. CLI prints final config and waits 3s before writing (Ctrl-C escape) unless `--yes` flag passed.

Exit codes: `0` success, `1` preflight failure, `2` verify mismatch, `3` write error, `4` commit/push error.

## Error handling

| Failure                                           | Detection                             | Response                                                                                                         |
| ------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Source unreachable (pg down / vault path missing) | constructor throws                    | Exit 1, log connection / path                                                                                    |
| Dim mismatch without `--reembed`                  | preflight                             | Exit 1, hint `--reembed`                                                                                         |
| Drizzle migrations stale                          | preflight                             | Exit 1, hint `npm run db:migrate`                                                                                |
| Target pg not empty (vault→pg)                    | preflight `count(*)`                  | Exit 1, hint TRUNCATE                                                                                            |
| Write phase mid-run failure                       | repo throws                           | Exit 3, log offending entity id; partial state remains. User repairs preconditions and re-runs                   |
| Bulk commit fails (pg→vault)                      | `git commit` exit ≠ 0                 | Exit 4, log; vault writes already on disk and lance index is consistent. User can `git add -A` + commit manually |
| Push fails after commit                           | `pushQueue.drain` returns failure     | Exit 4, log. Local state correct; next normal session will retry push                                            |
| Verify mismatch                                   | counts diff                           | Exit 2, log per-kind diff. Writes are not rolled back (pg already committed; vault commit may stand)             |
| Drizzle insert FK violation (vault→pg)            | repo throws                           | Exit 3 — implies source vault has dangling references; abort with offending memory id                            |
| Lance upsert fails (pg→vault)                     | `vectorIndex.upsert` throws           | Exit 3 — markdown already written but vector missing; user re-runs `--reembed` or runs Phase 5 boot scan         |
| Embedding provider error during `--reembed`       | provider throws                       | Exit 3, log. Same recovery as lance failure                                                                      |
| Watcher accidentally enabled                      | preflight asserts `skipWatcher: true` | Exit 1 (developer error in CLI wiring; defensive check)                                                          |

### Invariants

- Migration runs while the agent-brain server is stopped. CLI does not check; user is trusted (server lock detection is a future-work item).
- `users/` privacy on pg→vault: `trackUsersInGit` flag flows from env into `VaultBackendConfig`. If it's false (default), user-scope memories land under gitignored `users/` and do not appear in the bulk commit. This is the same invariant the normal write path enforces.
- No destructive operations on either side. CLI never issues `TRUNCATE`, `DROP`, `git reset`, or `rm -rf`. All preconditions are caller-owned.
- Embeddings are not regenerated unless `--reembed` is explicit.

## Test strategy

Five test tiers, mirroring Phase 5 layout:

- **T1 — preflight unit tests** (`tests/cli/migrate/preflight.test.ts`).
  Cover dim check (match / mismatch / `--reembed` bypass), target-empty (empty / non-empty / table missing), drizzle currency (current / stale).
- **T2 — pg-to-vault unit tests** (`tests/cli/migrate/pg-to-vault.test.ts`).
  Mock both repos, assert FK-ordered calls per kind, embedding carry-over math, repo-throws → bubble.
- **T3 — vault-to-pg unit tests** (`tests/cli/migrate/vault-to-pg.test.ts`).
  Symmetric.
- **T4 — verify unit tests** (`tests/cli/migrate/verify.test.ts`).
  Counts-match → ok; counts-diff → reported per kind with src/dst values.
- **T5 — E2E parity smoke** (`tests/e2e/migration-roundtrip.test.ts`).
  Seed pg via existing test helpers with ~50 memories + comments + flags + relationships + 2 workspaces. Run `pg-to-vault` against tmpdir vault. Read back via fresh `VaultBackend`. Assert structural-equal `findById` for sample of 10 ids. Run `vault-to-pg` against fresh pg. Assert structural-equal vs original dump. PR-only with `--testTimeout=20000`. (Realizes the parity test described in design §428–429.)

Coverage gate from master spec: parsers ≥ 95%, repositories ≥ 85%. Migration code is CLI/glue; aim ≥ 85% for the `migrate/` subdir.

## Open questions

None. All architectural decisions are locked above. Implementation-level choices are plan-time details:

- argv parsing library (`commander` vs hand-rolled `process.argv` slice — `merge-memory.ts` is hand-rolled; either is fine).
- log format (plain text vs structured JSON for CI grepping).
- verify report rendering (markdown table vs aligned columns).
- exact `createWithEmbedding` ergonomics (extra arg vs options object) — pinned in implementation plan after grepping current `MemoryRepository.create` signature.

## Out of scope follow-ups (Phase 7 candidates)

- Streaming readers for large vaults (only matters at >10k memories).
- Server-running detection (lock file or PID check) so CLI refuses to run while a live server holds the vault.
- `agent-brain` unified CLI dispatcher subsuming `migrate-*` plus future maintenance commands (`repair`, `reindex`, `audit`).
- `--mode=merge` for vault→pg if a real use case appears (no current driver).
