# Vault Backend Phase 4b — Git Sync (Push Queue + Pull on Session Start) Design

## Context

Phase 4a (merged as `4198fac`) wired `git commit` into every `Vault*Repository` mutation with `AB-*` trailers, bootstrapped `.gitignore` / `.gitattributes`, and enforced a `users/`-gitignored privacy invariant. Push and pull were explicitly deferred to Phase 4b. This spec closes that gap so a vault-backed agent-brain can round-trip writes between clones over a git remote with bounded staleness.

Phase 4b is the last sync-layer phase before Phase 5 (chokidar watcher). Phase 4c reimplements `VaultAuditRepository` on `git log --follow`.

## Goals

1. Every successful write produces a commit (Phase 4a) **and** a debounced asynchronous push to `origin`.
2. `memory_session_start` performs `pull --rebase --autostash` before serving, with a diff-driven LanceDB reindex of files the pull changed.
3. Crash-recoverable: a vault left in a dirty state by a post-fs-write commit failure (Phase 4a log-and-continue branch) is reconciled into a single recovery commit on next backend startup.
4. Offline / conflict / auth failures never block writes and surface to the caller through `memory_session_start` envelope `meta`.
5. Writes on one clone appear on another clone within seconds (debounce + push + pull on next `memory_session_start`).

## Non-Goals (Phase 4c / 5)

- `VaultAuditRepository` on `git log` (Phase 4c).
- Smart YAML-frontmatter merge driver (Phase 4c). Phase 4b relies on the `*.md merge=union` driver already set by Phase 4a; YAML-collision rebase conflicts abort the rebase and surface `pull_conflict: true`, and the user resolves manually (Obsidian, CLI, or next session).
- Chokidar watcher for external edits (Phase 5).
- Surfacing parse errors as per-memory flags — Phase 4b only counts them in the envelope.

## Decisions

| Area                                 | Decision                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote URL source                    | Single env var `AGENT_BRAIN_VAULT_REMOTE_URL`. No new config-file field.                                                                                                                      |
| Origin add policy                    | `ensureRemote` adds `origin` on fresh init when env var set; existing non-matching `origin` URL is left alone + warn-log (user intent wins).                                                  |
| Push cadence                         | Debounced 5s coalesce, single-flight one subprocess at a time. Retry backoff `[5s, 30s, 5m, 30m]`, then stay at 30m. New commits during backoff bump debounce but do not reset backoff timer. |
| Pull cadence                         | Once per `memory_session_start`. No background pull.                                                                                                                                          |
| Pull strategy                        | `pull --rebase --autostash`. Rebase conflict → `rebase --abort` + `pull_conflict: true` in meta; serve local (stale).                                                                         |
| Offline detection                    | Push/pull subprocess network-class failure flips `offline: true` for that envelope. Next successful push/pull clears the flag.                                                                |
| Reconciliation                       | `VaultBackend.create`, after `ensureVaultGit` and before serving, runs `git status --porcelain` and commits any dirty tracked `*.md` paths in one commit with trailer `AB-Action: reconcile`. |
| Diff reindex scope                   | Only memory markdown paths (`workspaces/**/memories/*.md`, `project/memories/*.md`, `users/**/memories/*.md`). Other changed paths (`.gitignore`, `.gitattributes`) ignored by reindex.       |
| Hash reuse                           | Phase 3 `content_hash` on lance row is the reindex short-circuit: unchanged hash → skip re-embed, mirror metadata only.                                                                       |
| Privacy invariant                    | Unchanged from Phase 4a — `assertUsersIgnored` still runs at every mutation; push queue simply pushes whatever Phase 4a committed.                                                            |
| Scope of `VaultBackend.sessionStart` | New backend method invoked by the `memory_session_start` MCP tool; not an MCP tool itself. Pg backend no-ops.                                                                                 |

## Architecture

### New files

```
src/backend/vault/git/
├── push-queue.ts          # PushQueue: debounce, single-flight, backoff
├── remote.ts              # ensureRemote({git, remoteUrl})
├── pull.ts                # syncFromRemote({git})
└── reconcile.ts           # reconcileDirty({git, root})

src/backend/vault/
└── session-start.ts       # VaultBackend.sessionStart orchestrator + diff reindex
```

Wiring in `src/backend/vault/index.ts` (`VaultBackend.create`):

```
VaultBackend.create(root, dims, { trackUsersInGit?, pushDebounceMs?, pushBackoffMs? })
  ├─ ensureVaultGit({ root, trackUsers })
  ├─ ensureRemote({ git, remoteUrl: env.AGENT_BRAIN_VAULT_REMOTE_URL })
  ├─ reconcileDirty({ git, root })                # post-crash recovery
  ├─ vectorIndex = VaultVectorIndex.create(...)
  ├─ gitOps = new GitOpsImpl({ root })
  ├─ pushQueue = new PushQueue({ git, debounceMs, backoffMs })
  ├─ gitOps.afterCommit = () => pushQueue.request()    # hook, not an event-bus
  ├─ repos = { memory, workspace, comment, flag, relationship, ... }
  └─ return VaultBackend { ...repos, sessionStart(), shutdown() }
```

### Write pipeline delta

Phase 4a ended inside the per-file lock with `gitOps.stageAndCommit(...)`. Phase 4b adds one non-blocking call after lock release:

```
acquire per-file lock
  ├─ [phase 2a-4a unchanged]
  └─ gitOps.stageAndCommit(paths, subject, trailers)
release lock
→ gitOps.afterCommit?.()                         # fire-and-forget
```

The `afterCommit` hook defaults to `undefined`; `VaultBackend.create` sets it to `pushQueue.request`. Keeping the hook on `GitOpsImpl` (rather than letting every repo know about the push queue) preserves the Phase 4a repo → `GitOps` seam.

### PushQueue state machine

```
            request()                request()
              │                        │
              ▼                        ▼
        ┌─────────┐   debounce    ┌───────────┐
        │  idle   │──────────────▶│ scheduled │
        └─────────┘               └───────────┘
              ▲                        │ timer
              │                        ▼
     success  │                  ┌───────────┐
       ┌──────┤                  │ in-flight │
       │      │                  └───────────┘
       │      │ retry backoff        │
       │      │                      ├─ success ─┐
       │      │                      └─ failure  │
       │      │                                  │
       │   ┌──┴──────┐                           │
       │   │ backoff │◀──────────────────────────┘
       │   └─────────┘
       └───── timer fires ────────▶ in-flight
```

- `idle`: no pending work.
- `scheduled`: debounce timer running. `request()` bumps its deadline.
- `in-flight`: one `git push` subprocess active. New `request()` calls queue a follow-up and drain on completion.
- `backoff`: last push failed. Backoff timer fires a single retry. New `request()` calls do NOT shorten the timer (avoids hammering dead remote) but mark that drain is still needed.

Shutdown: `PushQueue.close()` cancels pending timers, awaits in-flight, returns. `VaultBackend.shutdown()` calls it.

### Session start flow

`VaultBackend.sessionStart()` returns envelope meta and drives pull + reindex:

```
async sessionStart(): Promise<VaultSessionStartMeta> {
  const pull = await syncFromRemote({ git });          // pull --rebase --autostash
  let parseErrors = 0;
  if (pull.changedPaths.length) {
    parseErrors = await diffReindex({
      paths: pull.changedPaths,
      root, vectorIndex
    });
  }
  const unpushed = await pushQueue.unpushedCommits();
  pushQueue.request();                                 // kick drain if behind
  return {
    offline: pull.offline,
    pull_conflict: pull.conflict,
    unpushed_commits: unpushed > 0 ? unpushed : undefined,
    parse_errors: parseErrors > 0 ? parseErrors : undefined,
  };
}
```

`memory_session_start` MCP tool merges the returned `meta` fields into its existing envelope `meta`. Pg backend implements a no-op `sessionStart()` that returns `{}`.

### Diff-driven reindex

Input: `changedPaths: string[]` from `syncFromRemote` (`git diff --name-only <prev-HEAD>..HEAD`).

```
for path in changedPaths:
    if not matches(workspaces/**/memories/*.md | project/memories/*.md | users/**/memories/*.md):
        continue
    try:
        parsed = parseMemoryFile(path)
    except ParseError:
        parseErrors += 1
        continue
    newHash = sha256(parsed.body)
    existingHash = vectorIndex.getContentHash(parsed.frontmatter.id)
    if existingHash === newHash:
        vectorIndex.upsertMetaOnly(parsed.frontmatter)   # no re-embed
    else:
        # re-embed via existing embedding pipeline
        embedding = await embed(parsed.body)
        vectorIndex.upsert({ ...parsed.frontmatter, embedding, content_hash: newHash })
```

`parseMemoryFile` failure classes (YAML broken by union merge, unknown type, missing required field) all increment `parse_errors`. The file stays on disk — next human edit or next commit's post-hook validation (Phase 4c / 5) handles surfacing.

### Reconciliation on backend startup

Runs after `ensureVaultGit`, before `VaultBackend` returns:

```
reconcileDirty({ git, root }):
    status = await git.status()
    dirtyMarkdown = status.modified + status.not_added
        filter paths that are *.md AND are inside a memory path
    if dirtyMarkdown is empty: return
    await git.add(dirtyMarkdown)
    await git.commit(
        "[agent-brain] reconcile: post-crash recovery",
        dirtyMarkdown,
        trailers: [
            AB-Action: reconcile,
            AB-Actor: agent-brain,
            AB-Reason: post-crash-recovery
        ]
    )
```

Uses the same `GitOpsImpl` mutex (Phase 4a memory `UKNx4APvbydG4ukOWmo6L` gotcha #1) and scoped-commit path contract so a concurrent first write cannot cross-attribute. Runs once per backend create.

Untracked markdown files (e.g. user manually dropped a file in `memories/`) are NOT reconciled — out of scope for a crash-recovery path and would require validation. Phase 5 watcher handles that flow.

### Remote URL plumbing

`ensureRemote` reads `process.env.AGENT_BRAIN_VAULT_REMOTE_URL`:

| Current state of `.git/config` | Env var set? | Action                                                                         |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------ |
| No `origin`                    | Yes          | `git remote add origin <url>`                                                  |
| No `origin`                    | No           | No-op. Push queue still runs but all push attempts no-op with `offline: true`. |
| `origin` matches env           | Yes          | No-op.                                                                         |
| `origin` differs from env      | Yes          | Warn-log, leave existing. User wins.                                           |
| `origin` set                   | No           | No-op.                                                                         |

When no remote is configured at all, push attempts short-circuit before invoking `git push`: `PushQueue.request()` checks `git.getRemotes(true)` once at start and caches "no remote" → push becomes a no-op until backend restart. (Refreshing a remote addition at runtime is out of scope; `VaultBackend` restart is the seam.)

## Error handling matrix

| Failure                          | Source                | Behavior                                                                | Envelope meta                   |
| -------------------------------- | --------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| Push network failure             | PushQueue             | Backoff; next attempt per schedule                                      | `offline: true` until recovered |
| Push auth / permission failure   | PushQueue             | Backoff + `error`-level log; user must repair                           | `offline: true`                 |
| Push non-fast-forward (diverged) | PushQueue             | Next `memory_session_start` pull will rebase + retry; do not force-push | `unpushed_commits: N`           |
| Pull network failure             | `syncFromRemote`      | Serve local                                                             | `offline: true`                 |
| Pull rebase conflict             | `syncFromRemote`      | `rebase --abort`; serve local (pre-pull state)                          | `pull_conflict: true`           |
| Pull auth failure                | `syncFromRemote`      | Serve local                                                             | `offline: true`                 |
| Reconcile commit fails           | `VaultBackend.create` | `error`-level log; continue startup. Next successful write re-stages.   | n/a                             |
| Diff reindex parse error         | `diffReindex`         | Count + skip the file                                                   | `parse_errors: N`               |
| Repo corrupt / missing `HEAD`    | `syncFromRemote`      | Throw `VaultGitCorruptError` — fatal, backend create rejects            | n/a (startup fails)             |

## Config surface

### Env vars

| Name                           | Required | Purpose                                     |
| ------------------------------ | -------- | ------------------------------------------- |
| `AGENT_BRAIN_VAULT_REMOTE_URL` | No       | Remote URL for `ensureRemote` on fresh init |

### `VaultBackendConfig` additions

```ts
interface VaultBackendConfig {
  // existing fields...
  remoteUrl?: string; // explicit override of env var (tests)
  pushDebounceMs?: number; // default 5000
  pushBackoffMs?: readonly number[]; // default [5000, 30000, 300000, 1800000]
}
```

Explicit config wins over env var. Env wins over nothing.

## Envelope meta schema

`memory_session_start` envelope gains (merged onto existing `meta` object):

```ts
interface VaultSessionStartMeta {
  offline?: true;
  unpushed_commits?: number; // omitted when 0
  pull_conflict?: true;
  parse_errors?: number; // omitted when 0
}
```

All fields optional; absent = healthy. Pg backend contributes `{}`.

## Testing

### Unit tests

1. **`push-queue.test.ts`**
   - Debounce coalesces N rapid `request()` calls into one push.
   - Single-flight: second push does not start until first completes.
   - Backoff schedule `[5s, 30s, 5m, 30m]` with injected clock.
   - Successful push after backoff resets schedule.
   - `close()` cancels pending timers, awaits in-flight, is idempotent.
   - `request()` during backoff queues drain without shortening timer.
2. **`remote.test.ts`**
   - No origin + env set → `git remote add origin`.
   - Existing matching origin + env set → no-op.
   - Existing non-matching origin + env set → no-op + warn-log.
   - No origin + no env → no-op.
3. **`pull.test.ts`**
   - Clean fast-forward → `changedPaths` populated, no conflict/offline.
   - Up-to-date → empty `changedPaths`.
   - Rebase conflict → `conflict: true`, `git rebase --abort` invoked, working tree clean.
   - Network failure → `offline: true`, no throw.
4. **`reconcile.test.ts`**
   - Dirty markdown on startup → one commit with `AB-Action: reconcile`.
   - Clean startup → no commit.
   - Untracked markdown → not reconciled.
   - Dirty gitignored file → not reconciled.
5. **`session-start.test.ts`**
   - All-happy path → `meta = {}`.
   - Offline pull → `meta.offline = true`.
   - Conflict → `meta.pull_conflict = true`.
   - Unpushed commits → `meta.unpushed_commits = N`.
   - Parse error in a changed file → `meta.parse_errors = 1`.
6. **`diff-reindex.test.ts`**
   - Unchanged `content_hash` → `upsertMetaOnly` path.
   - Changed body → full upsert with new embedding.
   - Parse error → counted, does not abort.
   - Non-memory path → skipped.

### Integration

7. **`tests/integration/vault/two-clone-sync.test.ts`**
   - Bare repo + two `VaultBackend` instances in same process in distinct temp dirs, both with `AGENT_BRAIN_VAULT_REMOTE_URL` pointing at bare repo.
   - Cases:
     - Happy: A `memory_create` → A push → B `sessionStart` → B sees memory via search.
     - Concurrent non-conflicting writes on different files → both pushed, both pulled, merge-free.
     - Concurrent writes on same file with diverging frontmatter → B pulls, rebase conflict, `meta.pull_conflict=true`, B retains local.
     - Offline: bare repo removed mid-run → A write still commits, push fails, `meta.offline=true`.
8. **`tests/unit/server-boot.test.ts` extension**
   - Spawn under `AGENT_BRAIN_BACKEND=vault` + `AGENT_BRAIN_VAULT_REMOTE_URL=<bare-repo>` and assert boot succeeds and no `error`-level logs from push queue (push coalesce + no commits yet).

### CI

No new CI layers. Integration tests run under the existing PR-time integration job. Benchmarks out of scope for 4b; pushed to 4c or perf phase.

## Phased rollout inside 4b

1. Primitives: `push-queue.ts`, `remote.ts`, `pull.ts`, `reconcile.ts` with unit tests.
2. `VaultBackend` wiring: `sessionStart`, reconciliation on create, `afterCommit` hook plumbed into `GitOpsImpl`.
3. `memory_session_start` MCP tool merges backend `sessionStart` meta into envelope.
4. Two-clone integration test + server-boot extension.
5. Docs: update `docs/superpowers/specs/2026-04-21-vault-backend-design.md` status section to mark Phase 4b done; add envelope meta reference to copilot + claude snippets if they reference `memory_session_start` output shape.

## Open questions

None. All decisions locked above. Implementation-time choices (exact error class names, exact subprocess invocation flags) are plan-time details for `writing-plans`.

## Handoff to Phase 4c

- `VaultAuditRepository` reimplemented over `git log --follow` + trailer parser. Deletion of `_audit/` JSONL storage.
- Smart YAML frontmatter merge driver (replaces `merge=union` for memory markdown).
- Surfacing `parse_errors` as per-memory flags (consolidation producer).
- Performance budget verification on the full write path (commit + push under load).
