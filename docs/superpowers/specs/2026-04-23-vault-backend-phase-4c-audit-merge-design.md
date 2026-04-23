# Vault Backend Phase 4c — Audit on Git Log + Smart Merge Driver Design

## Context

Phase 4b (merged as `243dc36`) closed the sync layer: debounced push queue, `pull --rebase --autostash` on `memory_session_start`, diff-driven LanceDB reindex, and a `*.md merge=union` `.gitattributes` rule that keeps body text merges from blocking rebases. YAML-frontmatter conflicts still abort the rebase and surface `pull_conflict: true`; `VaultAuditRepository` still writes JSONL files under `_audit/`.

Phase 4c removes both remaining storage affordances that duplicate what git already gives us. The audit repository moves onto `git log`; `merge=union` is replaced with a field-aware memory merge driver. Phase 4d will pick up the remaining scope from the Phase 4b handoff (per-memory `parse_errors` flags and a full write-path perf budget).

## Goals

1. `VaultAuditRepository.findByMemoryId(id)` returns the same `AuditEntry[]` shape pg returns, reconstructed from `git log --grep='^AB-Memory: <id>$'` + blob reads — with no writes to `_audit/`.
2. Concurrent edits to memory frontmatter on two clones no longer abort the rebase with YAML-collision conflicts: a custom merge driver parses both sides, merges per documented field rules, and writes a clean result.
3. Any input the driver cannot safely merge (immutable-field divergence, parse failure) exits non-zero → rebase conflict → existing Phase 4b `pull_conflict: true` surface. No silent data loss.
4. Bootstrap is idempotent: every `VaultBackend.create` rewrites the local `.git/config` merge-driver path; first 4c startup on a Phase 4b vault removes `*.md merge=union`, adds the three path-specific rules, and commits via the existing reconcile path.

## Non-Goals (Phase 4d)

- Surface `parse_errors` as per-memory flags (consolidation producer).
- Write-path perf budget verification under load.
- Revive `"merged"` `AuditAction` (orphaned enum — see issue #38). Deferred until memory consolidation feature lands.
- Chokidar watcher (Phase 5).
- Migration / backfill of existing `_audit/*.jsonl` — vault backend is dev-only; no deployed installs.

## Decisions

| Area                              | Decision                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase scope split                 | Phase 4c = audit + merge driver (touch commit format + `.gitattributes`). Phase 4d = parse_errors flags + perf (consolidation/observability).                                                                                                                                                                                                            |
| Audit query method                | Single `git log --all --grep='^AB-Memory: <id>$' --pretty=format:...` call, parsed in-process. Matches pg behavior (includes comments/flags on the memory, not just mutations).                                                                                                                                                                          |
| Audit diff shape                  | `{ before, after }` structured object — **not** raw patch text. Matches pg contract so the parameterized `audit-repository.test.ts` stays cross-backend.                                                                                                                                                                                                 |
| Audit diff reconstruction         | Per `updated` commit: `git show <sha>^:<path>` (parent blob) + `git show <sha>:<path>` (this blob); `parseMemoryFile` each; produce `{before, after}` each containing only `{content, title, type, tags, metadata}` — matches the exact shape `MemoryService.update` passes to `logUpdate` in pg-backed code (`src/services/memory-service.ts:701-720`). |
| Audit diff for non-update actions | `created`, `archived`, `commented`, `flagged`: `diff = null`. Matches pg behavior where these code paths pass no `diff` to `AuditService.log`.                                                                                                                                                                                                           |
| `_audit/` JSONL                   | Removed — writer deleted, directory gitignored on upgrade, no read fallback. Justified by dev-only status (no production installs).                                                                                                                                                                                                                      |
| Merge driver scope                | Full field-aware: parse both sides + base, apply per-field rules, re-serialize. Body text three-way diff3 with LWW-by-`updated_at` fallback on unresolvable hunks.                                                                                                                                                                                       |
| Merge driver packaging            | `package.json` `bin: { "agent-brain-merge-memory": "./dist/cli/merge-memory.js" }`. `.git/config` `[merge "agent-brain-memory"]` driver path resolved via `require.resolve` at every bootstrap.                                                                                                                                                          |
| Merge driver conflict surface     | Exit 1 on immutable-field divergence, parse error, or unknown schema version → git leaves file unmerged → Phase 4b's existing `pull_conflict: true` envelope field fires.                                                                                                                                                                                |
| `.gitattributes` rules            | Remove `*.md merge=union`; add three path-specific rules (`workspaces/**/memories/*.md`, `project/memories/*.md`, `users/**/memories/*.md`) all pointing at `merge=agent-brain-memory`. Non-memory `.md` (READMEs) falls through to git default.                                                                                                         |
| `.git/config` idempotency         | Rewritten every `VaultBackend.create`. Self-heals when `agent-brain` install path changes (e.g. version upgrade, `npm install -g` vs local).                                                                                                                                                                                                             |
| Migration from Phase 4b vaults    | First 4c startup: bootstrap detects `*.md merge=union`, edits `.gitattributes`, stages + commits as `AB-Action: reconcile`.                                                                                                                                                                                                                              |

## Per-Field Merge Rules

Applied in order by `src/cli/merge-memory.ts` after parsing ancestor, current ("ours"), and other ("theirs") via `parseMemoryFile`.

### Immutable — conflict on divergence

If any of these differ between ours and theirs (regardless of ancestor), driver exits 1:

- `id`
- `project_id`
- `created_at`

Rationale: these never change post-create in a well-behaved flow. Divergence indicates an id collision or corrupted frontmatter; silent pick would mask the problem.

### Monotonic — max of both, null-aware

- `updated_at` → `max(ours.updated_at, theirs.updated_at)`
- `archived_at` → `max` of non-null values; null only if both sides null
- `verified_at` + `verified_by` → treated as a pair; take the pair from whichever side has the later non-null `verified_at`

### Last-writer-wins by `updated_at`

One side's value wins wholesale; winner is the side with the greater `updated_at` (tie → ours):

- `title`, `content` (body text, see below), `type`, `scope`, `workspace_id`, `author`, `source`, `session_id`, `embedding_model`, `embedding_dimensions`, `version`

### Set union

- `tags` → `Array.from(new Set([...ours.tags ?? [], ...theirs.tags ?? []])).sort()`

### Per-key merge (metadata)

- `metadata` (arbitrary object) → shallow merge: for each key appearing in either side, pick the value from the side with the greater `updated_at`. Deep merge is out of scope — `metadata` is per-memory free-form; shallow is predictable.

### Body subsections — parsed from markdown, not frontmatter

Memory body is split by `splitBody()` into `{ content, relationshipSection, commentSection }`. After parsing, the driver merges each section:

- `## Comments` — append-only list merged by `id`; chronological ascending preserved.
- `## Relationships` — union by `(source_id, target_id, type)` tuple; on collision take the entry from the 'theirs' side. Rationale: `Relationship` has only `created_at`, not `updated_at`; until the schema carries an update timestamp, deterministic 'theirs wins' is the best we can do. Collisions are rare in practice — relationships are typically append-only from each clone.
- Inline flags (frontmatter `flags: []` block) — union by `id`; on collision take the entry from the 'theirs' side; `Flag` also lacks `updated_at`.

### Body text (`content`) merge

diff3 against the ancestor:

1. If diff3 produces no conflict markers → use that result.
2. If diff3 produces markers → fall back to LWW-by-`updated_at` (whole content from the winning side).

Rationale: Markdown body is semi-structured; silent marker injection is worse than consistent LWW since markers would break `parseMemoryFile` on subsequent reads.

### Derived — recompute after merge

Read from the merged body, not the sides' frontmatter:

- `flag_count` = merged unresolved flags count
- `comment_count` = merged comments count
- `relationship_count` = merged relationships count
- `last_comment_at` = max `created_at` across merged comments (null if none)

## Architecture

### New files

```
src/cli/
└── merge-memory.ts              # argv = [%A, %O, %B], reads three files,
                                  # applies per-field rules, writes merged
                                  # to %A, exit 0 | 1

src/backend/vault/
└── repositories/
    └── audit-repository.ts      # REWRITE — git log + blob-reparse reader;
                                  # create() becomes a no-op (delete when
                                  # AuditService loses its last vault caller).
```

### Deleted files

```
src/backend/vault/repositories/audit-repository.ts  # old JSONL reader, replaced
(_audit/*.jsonl on disk)                             # dev-only; not migrated
```

### Modified files

```
src/backend/vault/git/bootstrap.ts
  - GITATTRIBUTES_RULE = "*.md merge=union"
  + GITATTRIBUTES_RULES = [
  +   "workspaces/**/memories/*.md merge=agent-brain-memory",
  +   "project/memories/*.md merge=agent-brain-memory",
  +   "users/**/memories/*.md merge=agent-brain-memory",
  + ]
  + removeActiveRule(body, "*.md merge=union")   // upgrade path
  + ensureGitConfig({ driverAbsolutePath })       // [merge "agent-brain-memory"]

src/backend/vault/index.ts
  VaultBackend.create:
    after ensureVaultGit({ root, trackUsers })
      writes .git/config merge driver section with resolved driver path
    auditRepo built from the new git-log-backed reader

src/services/audit-service.ts
  No changes — interface-compatible swap.

src/backend/vault/git/trailers.ts
src/backend/vault/git/types.ts
  No schema additions; existing `AB-Memory:`, `AB-Action:`, `AB-Actor:`,
  `AB-Reason:` trailers contain everything `findByMemoryId` needs.

package.json
  "bin": { "agent-brain-merge-memory": "./dist/cli/merge-memory.js" }
```

### Data flow — `findByMemoryId`

```
AuditService.getHistory(memoryId)
  └─ VaultAuditRepository.findByMemoryId(memoryId)
      ├─ git log --all --pretty='%H%x00%aI%x00%B%x00' --grep='^AB-Memory: <id>$'
      │    returns N commits, each with sha + iso timestamp + full message
      │    (trailers parsed from message body)
      ├─ for each commit:
      │    ├─ parse trailers → { action, memoryId, actor, reason }
      │    ├─ derive file path from trailer + repo layout
      │    ├─ if action === "updated":
      │    │    git show <sha>^:<path>   → parent blob
      │    │    git show <sha>:<path>    → this blob
      │    │    parseMemoryFile each
      │    │    diff = { before: pick(parsed, FIELDS), after: pick(parsed, FIELDS) }
      │    │    where FIELDS = ["content","title","type","tags","metadata"]
      │    └─ else ("created" | "archived" | "commented" | "flagged" | ...):
      │         diff = null  // matches pg, which logs these without a diff
      ├─ map trailer action → AuditAction (drop vault-only trailers)
      └─ sort desc by created_at
```

### Data flow — merge during `pull --rebase`

```
git pull --rebase (Phase 4b syncFromRemote)
  └─ git invokes merge driver on conflicting memories/*.md
      └─ node <abs>/dist/cli/merge-memory.js %A %O %B
          ├─ read all three files
          ├─ parseMemoryFile(ancestor), parseMemoryFile(ours), parseMemoryFile(theirs)
          │    parse failure on any side → exit 1
          ├─ assert immutable fields agree (id, project_id, created_at)
          │    mismatch → exit 1
          ├─ merge per field rules
          ├─ serializeMemoryFile(merged) → write to %A
          └─ exit 0
  ├─ exit 0 → rebase continues; Phase 4b's reindex picks up the path
  └─ exit 1 → rebase aborts → pull_conflict: true in envelope meta
```

## Trailer → `AuditAction` mapping

The trailer schema (`CommitAction`) is wider than `AuditAction`. Reader drops what doesn't map:

| `AB-Action` trailer | `AuditAction` result                |
| ------------------- | ----------------------------------- |
| `created`           | `created`                           |
| `updated`           | `updated`                           |
| `archived`          | `archived`                          |
| `commented`         | `commented`                         |
| `flagged`           | `flagged`                           |
| `verified`          | (dropped, no AuditAction value)     |
| `unflagged`         | (dropped)                           |
| `related`           | (dropped — relationship-only event) |
| `unrelated`         | (dropped)                           |
| `workspace_upsert`  | (dropped — not memory-scoped)       |
| `reconcile`         | (dropped)                           |

Dropped actions would only appear under `findByMemoryId` if someone manually constructs a commit with `AB-Memory:` + one of these trailers, which no code path does today. Defensive to ignore rather than throw.

## Privacy invariant

Phase 4a's `assertUsersIgnored` continues to run on every mutation. The new merge driver does not change it: `users/**/*.md` files match a merge rule but are gitignored at the repo layer, so git will never hand them to the driver during a pull. Private content stays out of the remote regardless of driver behavior.

## Error handling

| Failure                                                    | Where        | Behavior                                                                       |
| ---------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `git log --grep` returns no commits                        | audit reader | return `[]`                                                                    |
| Parent blob missing (first commit, or amended pre-history) | audit reader | treat as `created`: `before = null`                                            |
| Blob parse fails                                           | audit reader | skip that entry, log warn; sibling entries still returned                      |
| Unknown `AB-Action` value                                  | audit reader | skip entry, log debug                                                          |
| Merge driver parse fails on any side                       | merge driver | exit 1 → rebase conflict → `pull_conflict: true`                               |
| Merge driver immutable-field mismatch                      | merge driver | exit 1 → rebase conflict → `pull_conflict: true`                               |
| Merge driver unknown schema version                        | merge driver | exit 1 → rebase conflict → `pull_conflict: true`                               |
| `.git/config` write fails during bootstrap                 | bootstrap    | propagates; `VaultBackend.create` fails. Next start retries.                   |
| `.gitattributes` commit fails during upgrade               | bootstrap    | dirty tree → Phase 4b reconcile path runs on next start, completes the commit. |

## Testing

**Unit (majority):**

- `src/backend/vault/parser/merge.test.ts` — pure-function field-merge tests against fixture markdown triples (ancestor, ours, theirs). One test per field rule + one per edge case (null metadata, empty tags, archived collision).
- `src/backend/vault/repositories/audit-repository.test.ts` — mock `simple-git` `log` and blob-read output; assert parse + diff reconstruction. Pg-parity assertions for `{before, after}` shape.
- `src/cli/merge-memory.test.ts` — argv-based invocation, reads/writes tmp files, asserts exit code and `%A` contents. Covers immutable-field conflict, parse error, successful merge paths.

**Contract (existing parameterized):**

- `tests/contract/repositories/audit-repository.test.ts` — stays green against both pg and vault. The `diff` contract is narrow: `null` for all actions except `updated`; for `updated`, `{ before, after }` each containing exactly the five fields the caller passes (`content`, `title`, `type`, `tags`, `metadata`). No derived counts (`flag_count`, `comment_count`, etc.) are in this subset, so the vault recompute strategy does not leak into the contract.

**Integration (smoke):**

- `tests/integration/vault/merge-driver.test.ts` — uses `tests/contract/repositories/_git-helpers.ts:setupBareAndTwoVaults`. Clone A and Clone B edit the same memory's frontmatter concurrently; push A; B pulls. Assert: clean rebase, merged frontmatter contains both sides' tag additions, single commit on top of shared base.
- `tests/integration/vault/audit-history.test.ts` — create + update + archive a memory through `AuditService`, call `getHistory`, assert shape matches pg behavior.

**Property (optional, add if time):**

- `tests/unit/backend/vault/parser/merge.property.test.ts` — fast-check generates random valid memory triples, asserts merge is commutative for tag/metadata fields and idempotent for monotonic fields.

## Open questions

None. All decisions locked above. Implementation-level choices (exact glob for the `git log --grep` regex, exact `diff3` invocation flags, exact `require.resolve` fallback order) are plan-time details for `writing-plans`.

## Handoff to Phase 4d

- Surface `parse_errors` as per-memory flags (consolidation producer reads `AB-Action: ` entries where blob parse failed and emits a `verify` flag).
- Write-path perf budget verification on commit + push under load.
- Revive `merged` `AuditAction` + add `merged` to `CommitAction` if memory-consolidation feature lands (#38).
