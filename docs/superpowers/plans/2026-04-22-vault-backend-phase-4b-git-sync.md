# Vault Backend Phase 4b — Git Sync (Push Queue + Pull on Session Start) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the git-sync loop on the vault backend. Every commit from Phase 4a now debounced-pushes to `origin`. Every `memory_session_start` pulls with `--rebase --autostash`, reindexes the lance table for changed memory markdown, and surfaces offline / conflict / unpushed / parse-error state through envelope `meta`. A post-crash startup reconciliation collapses dirty markdown into a single recovery commit so the vault is never left partially synced.

**Architecture:** Four new primitives under `src/backend/vault/git/` — `push-queue.ts`, `remote.ts`, `pull.ts`, `reconcile.ts` — plus a new `src/backend/vault/session-start.ts` orchestrator. `GitOpsImpl` gains an optional `afterCommit` callback that `VaultBackend.create` wires to `pushQueue.request()`. The `StorageBackend` interface gains a `sessionStart()` method returning backend-specific envelope meta; pg backend no-ops. `MemoryService.sessionStart` awaits the backend hook once at the start and merges its meta into the response envelope. Pull-path reindex relies on Phase 3 `content_hash` to skip re-embedding unchanged files.

**Tech Stack:** `simple-git` (existing), Node.js, TypeScript, vitest, fast-check (existing), `@lancedb/lancedb` (existing).

---

## Spec

`docs/superpowers/specs/2026-04-22-vault-backend-phase-4b-git-sync-design.md` (commit `908a0ec`). All design decisions (remote URL via `AGENT_BRAIN_VAULT_REMOTE_URL` env, debounce 5s, backoff `[5s, 30s, 5m, 30m]`, pull → rebase+autostash, reconcile-on-create, envelope meta schema) are locked there. This plan implements that spec.

## File map

### Create

| Path                                              | Purpose                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `src/backend/vault/git/push-queue.ts`             | `PushQueue` — debounced single-flight push with backoff       |
| `src/backend/vault/git/remote.ts`                 | `ensureRemote({git, remoteUrl})` — add origin if absent       |
| `src/backend/vault/git/pull.ts`                   | `syncFromRemote({git})` — pull --rebase --autostash           |
| `src/backend/vault/git/reconcile.ts`              | `reconcileDirty({git, root})` — post-crash recovery commit    |
| `src/backend/vault/session-start.ts`              | `runSessionStart(...)` + `diffReindex(...)` — orchestrator    |
| `src/backend/vault/types.ts`                      | Shared vault types (currently none) — `VaultSessionStartMeta` |
| `tests/unit/backend/vault/git/push-queue.test.ts` | Unit tests for push queue                                     |
| `tests/unit/backend/vault/git/remote.test.ts`     | Unit tests for ensureRemote                                   |
| `tests/unit/backend/vault/git/pull.test.ts`       | Unit tests for syncFromRemote                                 |
| `tests/unit/backend/vault/git/reconcile.test.ts`  | Unit tests for reconcileDirty                                 |
| `tests/unit/backend/vault/session-start.test.ts`  | Unit tests for runSessionStart + diffReindex                  |
| `tests/integration/vault/two-clone-sync.test.ts`  | Two-clone integration test                                    |

### Modify

| Path                                                        | Change                                                                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backend/types.ts`                                      | Add `sessionStart()` to `StorageBackend`, add `BackendSessionStartMeta` type                                                                                                                              |
| `src/backend/postgres/index.ts`                             | Add no-op `sessionStart()` returning `{}`                                                                                                                                                                 |
| `src/backend/vault/index.ts`                                | Add fields (`remoteUrl`, `pushDebounceMs`, `pushBackoffMs`) to `VaultBackendConfig`; wire `PushQueue` + `ensureRemote` + `reconcileDirty`; implement `sessionStart`; extend `close()` to drain push queue |
| `src/backend/vault/git/types.ts`                            | Add optional `afterCommit?: () => void` to `GitOps` interface; `GitOpsImpl` calls it after successful commit; `NoopGitOps` no-ops the field                                                               |
| `src/backend/vault/git/git-ops.ts`                          | Invoke `afterCommit` after `#serialize` block succeeds                                                                                                                                                    |
| `src/backend/factory.ts`                                    | Plumb `AGENT_BRAIN_VAULT_REMOTE_URL` env var through to `VaultBackend.create`                                                                                                                             |
| `src/services/memory-service.ts`                            | Call `backend.sessionStart()` from `MemoryService.sessionStart()`, merge returned meta into result envelope                                                                                               |
| `src/tools/memory-session-start.ts`                         | No changes needed (envelope passes through)                                                                                                                                                               |
| `tests/unit/server-boot.test.ts`                            | Extend with `AGENT_BRAIN_BACKEND=vault` + `AGENT_BRAIN_VAULT_REMOTE_URL=<bare>` smoke                                                                                                                     |
| `tests/contract/repositories/_git-helpers.ts`               | Add helpers for bare-repo + clone setup used by integration test                                                                                                                                          |
| `docs/superpowers/specs/2026-04-21-vault-backend-design.md` | Tick Phase 4 row with 4b-done note                                                                                                                                                                        |

### Do not touch

- `src/backend/vault/git/bootstrap.ts` (phase 4a, stable — remote config is separate)
- `src/backend/vault/vector/lance-index.ts` (phase 3, stable)
- Any `Vault*Repository` file — write pipeline unchanged
- `users-gitignore-invariant.ts` — unchanged

---

## Task 1: Backend interface — `sessionStart` + envelope meta type

**Goal:** Add the backend hook surface so both backends can opt into contributing envelope meta. No vault logic yet.

**Files:**

- Modify: `src/backend/types.ts`
- Modify: `src/backend/postgres/index.ts`
- Test: `tests/unit/backend/factory.test.ts` (add assertion)

- [ ] **Step 1: Add meta type + interface method in `src/backend/types.ts`**

Edit `src/backend/types.ts`. After the existing imports and above `StorageBackend`:

```ts
/**
 * Envelope meta fields contributed by the backend at memory_session_start.
 * All fields optional — absent means healthy. Merged into the MemoryService
 * session-start envelope meta. The pg backend always returns {}; vault
 * populates based on pull + push-queue state.
 */
export interface BackendSessionStartMeta {
  offline?: true;
  unpushed_commits?: number;
  pull_conflict?: true;
  parse_errors?: number;
}
```

Then add to `StorageBackend`:

```ts
  /**
   * Called by MemoryService.sessionStart before composing the response.
   * Backend-specific sync/reconciliation. Returned fields merge into
   * envelope meta.
   */
  sessionStart(): Promise<BackendSessionStartMeta>;
```

- [ ] **Step 2: Add no-op to `PostgresBackend`**

Edit `src/backend/postgres/index.ts`. Find the class and add:

```ts
  async sessionStart(): Promise<BackendSessionStartMeta> {
    return {};
  }
```

Add `BackendSessionStartMeta` to the existing `from "../types.js"` import.

- [ ] **Step 3: Add failing test in `tests/unit/backend/factory.test.ts`**

Append:

```ts
import { describe, expect, it } from "vitest";
import { createBackend } from "../../../src/backend/factory.js";

describe("backend sessionStart", () => {
  it("pg backend returns empty meta", async () => {
    const backend = await createBackend({ name: "postgres" });
    try {
      const meta = await backend.sessionStart();
      expect(meta).toEqual({});
    } finally {
      await backend.close();
    }
  });
});
```

(If the existing file already uses `createBackend`, slot the `it(...)` into an existing `describe`.)

- [ ] **Step 4: Run test**

```
npx vitest run tests/unit/backend/factory.test.ts -t "pg backend returns empty meta"
```

Expected: PASS.

- [ ] **Step 5: Verify vault backend compile fails (good — we'll fix next)**

```
npm run typecheck
```

Expected: `VaultBackend` missing `sessionStart` — one error.

- [ ] **Step 6: Stub `VaultBackend.sessionStart` returning `{}` (temporary)**

In `src/backend/vault/index.ts`, add:

```ts
  async sessionStart(): Promise<BackendSessionStartMeta> {
    return {};
  }
```

Add `BackendSessionStartMeta` to imports. This is a placeholder replaced by Task 10.

- [ ] **Step 7: Run typecheck + full unit suite**

```
npm run typecheck && npm run test:unit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```
git add src/backend/types.ts src/backend/postgres/index.ts src/backend/vault/index.ts tests/unit/backend/factory.test.ts
git commit -m "feat(vault-sync): add StorageBackend.sessionStart interface + meta type"
```

---

## Task 2: `GitOps.afterCommit` hook

**Goal:** Let `GitOpsImpl` fire a callback after every successful commit. Push queue subscribes to this in Task 11.

**Files:**

- Modify: `src/backend/vault/git/types.ts`
- Modify: `src/backend/vault/git/git-ops.ts`
- Test: `tests/unit/backend/vault/git/git-ops.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/unit/backend/vault/git/git-ops.test.ts`:

```ts
it("fires afterCommit after a successful commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-ops-hook-"));
  try {
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    await git.init();
    await git.addConfig("user.email", "t@x", false, "local");
    await git.addConfig("user.name", "t", false, "local");

    const calls: number[] = [];
    const ops = new GitOpsImpl({ root });
    ops.afterCommit = () => calls.push(Date.now());

    const path = "note.md";
    await writeFile(join(root, path), "hi\n");
    await ops.stageAndCommit([path], "[t] first", {
      action: "created",
      actor: "a",
    });

    expect(calls).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not fire afterCommit when stageAndCommit throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-ops-hook-fail-"));
  try {
    const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
    await git.init();
    await git.addConfig("user.email", "t@x", false, "local");
    await git.addConfig("user.name", "t", false, "local");

    const calls: number[] = [];
    const ops = new GitOpsImpl({ root });
    ops.afterCommit = () => calls.push(Date.now());

    // Nothing to commit → VaultGitNothingToCommitError.
    await writeFile(join(root, "ignored.md"), "x\n");
    await git.add("ignored.md");
    await git.commit("initial", ["ignored.md"]);
    await expect(
      ops.stageAndCommit(["ignored.md"], "again", {
        action: "created",
        actor: "a",
      }),
    ).rejects.toThrow();

    expect(calls).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Ensure `simpleGit`, `scrubGitEnv`, `writeFile`, `mkdtemp`, `rm`, `tmpdir`, `join`, `GitOpsImpl` are imported at the top of the file (follow existing test imports).

- [ ] **Step 2: Run test — expect fail**

```
npx vitest run tests/unit/backend/vault/git/git-ops.test.ts -t "afterCommit"
```

Expected: FAIL (`afterCommit` does not exist on `GitOpsImpl`).

- [ ] **Step 3: Add `afterCommit` field to `GitOps` interface**

Edit `src/backend/vault/git/types.ts`. Inside `GitOps` interface:

```ts
  /**
   * Optional callback invoked after every successful stageAndCommit.
   * Fires outside the #serialize mutex but within the same async flow —
   * callers get a synchronous "commit landed" signal. Failures in the
   * callback are not propagated (fire-and-forget).
   */
  afterCommit?: () => void;
```

In `NoopGitOps` add:

```ts
  afterCommit?: () => void;
```

- [ ] **Step 4: Fire hook in `GitOpsImpl.stageAndCommit`**

Edit `src/backend/vault/git/git-ops.ts`. In `stageAndCommit` after the `#serialize` block returns:

```ts
  async stageAndCommit(
    paths: string[],
    subject: string,
    trailer: CommitTrailer,
  ): Promise<void> {
    if (paths.length === 0) {
      throw new Error("stageAndCommit: paths must be non-empty");
    }
    await this.#serialize(async () => {
      await this.git.add(paths);
      const status = await this.git.status();
      if (status.staged.length === 0 && status.created.length === 0) {
        throw new VaultGitNothingToCommitError(paths);
      }
      const body = formatTrailers(trailer);
      await this.git.commit(`${subject}\n\n${body}`, paths);
    });
    // Fire hook after the serialized block resolves so a callback that
    // itself calls into git cannot deadlock on the mutex. Swallow hook
    // errors — this is fire-and-forget.
    try {
      this.afterCommit?.();
    } catch {
      // ignored
    }
  }
```

Also add the public field:

```ts
export class GitOpsImpl implements GitOps {
  readonly enabled = true;
  afterCommit?: () => void;
  // ...
}
```

- [ ] **Step 5: Run test**

```
npx vitest run tests/unit/backend/vault/git/git-ops.test.ts -t "afterCommit"
```

Expected: PASS.

- [ ] **Step 6: Full git-ops suite + typecheck**

```
npx vitest run tests/unit/backend/vault/git/git-ops.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/backend/vault/git/types.ts src/backend/vault/git/git-ops.ts tests/unit/backend/vault/git/git-ops.test.ts
git commit -m "feat(vault-sync): add GitOps.afterCommit hook"
```

---

## Task 3: `ensureRemote` — origin URL plumbing

**Goal:** Read `AGENT_BRAIN_VAULT_REMOTE_URL` (or explicit config override), add `origin` on fresh init, warn on mismatch, leave existing alone.

**Files:**

- Create: `src/backend/vault/git/remote.ts`
- Create: `tests/unit/backend/vault/git/remote.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/backend/vault/git/remote.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";
import { ensureRemote } from "../../../../../src/backend/vault/git/remote.js";

async function makeRepo(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "remote-test-"));
  const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
  await git.init();
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("ensureRemote", () => {
  it("adds origin when absent + URL provided", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await ensureRemote({ git, remoteUrl: "git@example.com:x/y.git" });
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      expect(origin?.refs.fetch).toBe("git@example.com:x/y.git");
    } finally {
      await cleanup();
    }
  });

  it("no-ops when origin already matches", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await git.addRemote("origin", "git@example.com:x/y.git");
      await ensureRemote({ git, remoteUrl: "git@example.com:x/y.git" });
      const remotes = await git.getRemotes(true);
      expect(remotes).toHaveLength(1);
      expect(remotes[0].refs.fetch).toBe("git@example.com:x/y.git");
    } finally {
      await cleanup();
    }
  });

  it("leaves mismatched origin in place + warns", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await git.addRemote("origin", "git@existing:a/b.git");
      await ensureRemote({ git, remoteUrl: "git@new:c/d.git" });
      const remotes = await git.getRemotes(true);
      expect(remotes[0].refs.fetch).toBe("git@existing:a/b.git");
    } finally {
      await cleanup();
    }
  });

  it("no-ops when no URL and no origin", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      await ensureRemote({ git, remoteUrl: undefined });
      const remotes = await git.getRemotes(true);
      expect(remotes).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run — expect fail**

```
npx vitest run tests/unit/backend/vault/git/remote.test.ts
```

Expected: FAIL (module `remote.js` missing).

- [ ] **Step 3: Implement `ensureRemote`**

Create `src/backend/vault/git/remote.ts`:

```ts
import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";

export interface EnsureRemoteConfig {
  git: SimpleGit;
  remoteUrl: string | undefined;
}

/**
 * Adds `origin` to the vault repo when absent and `remoteUrl` is provided.
 * Leaves any existing `origin` alone — users may have configured the
 * remote manually and that intent wins. Mismatches are warn-logged.
 * Idempotent.
 */
export async function ensureRemote(cfg: EnsureRemoteConfig): Promise<void> {
  const remotes = await cfg.git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  if (origin) {
    if (cfg.remoteUrl && origin.refs.fetch !== cfg.remoteUrl) {
      logger.warn(
        `vault: AGENT_BRAIN_VAULT_REMOTE_URL (${cfg.remoteUrl}) differs from existing origin (${origin.refs.fetch}); leaving existing`,
      );
    }
    return;
  }
  if (!cfg.remoteUrl) return;
  await cfg.git.addRemote("origin", cfg.remoteUrl);
}
```

- [ ] **Step 4: Run — expect pass**

```
npx vitest run tests/unit/backend/vault/git/remote.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```
git add src/backend/vault/git/remote.ts tests/unit/backend/vault/git/remote.test.ts
git commit -m "feat(vault-sync): add ensureRemote"
```

---

## Task 4: `PushQueue` — debounce + single-flight

**Goal:** Class that coalesces rapid `request()` calls into one push, running one push subprocess at a time. No backoff yet.

**Files:**

- Create: `src/backend/vault/git/push-queue.ts`
- Create: `tests/unit/backend/vault/git/push-queue.test.ts`

- [ ] **Step 1: Write failing test (debounce + single-flight only)**

Create `tests/unit/backend/vault/git/push-queue.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PushQueue } from "../../../../../src/backend/vault/git/push-queue.js";

interface FakePushResult {
  resolve: (value: void) => void;
  reject: (err: Error) => void;
  calls: number;
}

function fakePusher(): { push: () => Promise<void>; state: FakePushResult } {
  const state: FakePushResult = {
    resolve: () => {},
    reject: () => {},
    calls: 0,
  };
  const push = () => {
    state.calls += 1;
    return new Promise<void>((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
  };
  return { push, state };
}

describe("PushQueue debounce + single-flight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid requests into one push", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    q.request();
    q.request();
    q.request();
    expect(state.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1);
    state.resolve();
    await q.close();
  });

  it("bumps debounce on each request", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    q.request();
    await vi.advanceTimersByTimeAsync(60);
    q.request();
    await vi.advanceTimersByTimeAsync(60);
    // Still not fired — second request reset timer to now+100.
    expect(state.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(state.calls).toBe(1);
    state.resolve();
    await q.close();
  });

  it("single-flight: second push waits for first to finish", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1);
    // Trigger follow-up push while first in-flight.
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1); // still blocked behind in-flight
    state.resolve();
    // Allow microtask queue + scheduled follow-up.
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(2);
    state.resolve();
    await q.close();
  });

  it("close() drains in-flight and cancels pending debounce", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1);
    state.resolve();
    q.request();
    const closed = q.close();
    // Pending debounce cancelled — no new push.
    await vi.advanceTimersByTimeAsync(1000);
    await closed;
    expect(state.calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```
npx vitest run tests/unit/backend/vault/git/push-queue.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement `PushQueue` (debounce + single-flight only, no backoff)**

Create `src/backend/vault/git/push-queue.ts`:

```ts
import { logger } from "../../../utils/logger.js";

export interface PushQueueConfig {
  /**
   * Performs the actual push. Injected so unit tests can use a fake
   * and the real backend wires a simple-git wrapper in Task 11.
   * Throwing any error keeps the queue in pending state; retry
   * scheduling is handled by the backoff logic (Task 5).
   */
  push: () => Promise<void>;
  debounceMs: number;
  backoffMs: readonly number[];
}

type State =
  | { kind: "idle" }
  | { kind: "scheduled"; timer: NodeJS.Timeout }
  | { kind: "in-flight"; follow: boolean }
  | { kind: "backoff"; timer: NodeJS.Timeout; attempt: number };

/**
 * Debounced, single-flight push queue. `request()` bumps a debounce
 * timer; when it fires, one push runs. Concurrent requests during an
 * in-flight push queue exactly one follow-up on completion.
 */
export class PushQueue {
  private state: State = { kind: "idle" };
  private closing = false;

  constructor(private readonly cfg: PushQueueConfig) {}

  request(): void {
    if (this.closing) return;
    switch (this.state.kind) {
      case "idle":
        this.#schedule();
        return;
      case "scheduled":
        clearTimeout(this.state.timer);
        this.#schedule();
        return;
      case "in-flight":
        this.state = { kind: "in-flight", follow: true };
        return;
      case "backoff":
        // Do not shorten backoff — just mark that we still need to push.
        // The backoff timer already owns the next attempt.
        return;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.state.kind === "scheduled") {
      clearTimeout(this.state.timer);
      this.state = { kind: "idle" };
    }
    if (this.state.kind === "backoff") {
      clearTimeout(this.state.timer);
      this.state = { kind: "idle" };
    }
    while (this.state.kind === "in-flight") {
      await new Promise((r) => setImmediate(r));
    }
  }

  #schedule(): void {
    const timer = setTimeout(() => {
      void this.#runPush();
    }, this.cfg.debounceMs);
    this.state = { kind: "scheduled", timer };
  }

  async #runPush(): Promise<void> {
    this.state = { kind: "in-flight", follow: false };
    try {
      await this.cfg.push();
      // Success path: drain follow-up if queued.
      const follow = this.state.kind === "in-flight" && this.state.follow;
      this.state = { kind: "idle" };
      if (follow && !this.closing) {
        this.#schedule();
      }
    } catch (err) {
      // Backoff path — implemented in Task 5. For now just log + idle.
      logger.warn(
        `vault push failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.state = { kind: "idle" };
    }
  }
}
```

- [ ] **Step 4: Run — expect pass**

```
npx vitest run tests/unit/backend/vault/git/push-queue.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```
git add src/backend/vault/git/push-queue.ts tests/unit/backend/vault/git/push-queue.test.ts
git commit -m "feat(vault-sync): PushQueue debounce + single-flight"
```

---

## Task 5: `PushQueue` — backoff on failure

**Goal:** When `push` rejects, the queue enters `backoff` for `backoffMs[attempt]` before retrying, with `attempt` capped at the last index. Success resets `attempt` to 0.

**Files:**

- Modify: `src/backend/vault/git/push-queue.ts`
- Modify: `tests/unit/backend/vault/git/push-queue.test.ts`

- [ ] **Step 1: Write failing backoff tests**

Append to `push-queue.test.ts`:

```ts
describe("PushQueue backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries according to backoffMs schedule", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({
      push,
      debounceMs: 100,
      backoffMs: [500, 2000],
    });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(1);
    state.reject(new Error("boom"));
    // Wait for the rejection to propagate and state to flip to backoff.
    await vi.advanceTimersByTimeAsync(0);

    // No retry before 500ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(2);

    state.reject(new Error("boom again"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(3);
    state.resolve();
    await q.close();
  });

  it("stays at last backoff step after exhausting schedule", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [500] });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    state.reject(new Error("1"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    state.reject(new Error("2"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.calls).toBe(3);
    state.resolve();
    await q.close();
  });

  it("success resets backoff to 0", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({
      push,
      debounceMs: 100,
      backoffMs: [500, 2000],
    });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    state.reject(new Error("1"));
    await vi.advanceTimersByTimeAsync(500);
    state.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // Trigger another push.
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    state.reject(new Error("2"));
    await vi.advanceTimersByTimeAsync(0);
    // Should wait 500ms (attempt=0) again, not 2000ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(state.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(4);
    state.resolve();
    await q.close();
  });

  it("request during backoff does not shorten timer", async () => {
    const { push, state } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [1000] });
    q.request();
    await vi.advanceTimersByTimeAsync(100);
    state.reject(new Error("boom"));
    await vi.advanceTimersByTimeAsync(0);
    q.request(); // during backoff
    await vi.advanceTimersByTimeAsync(500);
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.calls).toBe(2);
    state.resolve();
    await q.close();
  });
});
```

- [ ] **Step 2: Run — expect fail**

```
npx vitest run tests/unit/backend/vault/git/push-queue.test.ts -t "backoff"
```

Expected: FAIL (tests see `calls` stuck at 1).

- [ ] **Step 3: Implement backoff branch**

Replace `#runPush` in `src/backend/vault/git/push-queue.ts`:

```ts
  private attempt = 0;

  async #runPush(): Promise<void> {
    this.state = { kind: "in-flight", follow: false };
    try {
      await this.cfg.push();
      const follow = this.state.kind === "in-flight" && this.state.follow;
      this.state = { kind: "idle" };
      this.attempt = 0;
      if (follow && !this.closing) {
        this.#schedule();
      }
    } catch (err) {
      logger.warn(
        `vault push failed (attempt ${this.attempt + 1}): ${err instanceof Error ? err.message : String(err)}`,
      );
      if (this.closing) {
        this.state = { kind: "idle" };
        return;
      }
      const ms = this.#backoffMs();
      this.attempt += 1;
      const timer = setTimeout(() => {
        void this.#runPush();
      }, ms);
      this.state = { kind: "backoff", timer, attempt: this.attempt };
    }
  }

  #backoffMs(): number {
    if (this.cfg.backoffMs.length === 0) return 0;
    const idx = Math.min(this.attempt, this.cfg.backoffMs.length - 1);
    return this.cfg.backoffMs[idx];
  }
```

- [ ] **Step 4: Run — expect pass**

```
npx vitest run tests/unit/backend/vault/git/push-queue.test.ts
```

Expected: PASS (all).

- [ ] **Step 5: Commit**

```
git add src/backend/vault/git/push-queue.ts tests/unit/backend/vault/git/push-queue.test.ts
git commit -m "feat(vault-sync): PushQueue failure backoff"
```

---

## Task 6: `PushQueue.unpushedCommits()`

**Goal:** Expose the `@{u}..HEAD` count so `sessionStart` can surface `unpushed_commits`. Accept a separate `unpushedCommits` function in `PushQueueConfig` (injected for testability).

**Files:**

- Modify: `src/backend/vault/git/push-queue.ts`
- Modify: `tests/unit/backend/vault/git/push-queue.test.ts`

- [ ] **Step 1: Write failing test**

Append to `push-queue.test.ts`:

```ts
describe("PushQueue.unpushedCommits", () => {
  it("delegates to injected counter", async () => {
    const { push } = fakePusher();
    const q = new PushQueue({
      push,
      debounceMs: 100,
      backoffMs: [],
      countUnpushed: async () => 7,
    });
    expect(await q.unpushedCommits()).toBe(7);
    await q.close();
  });

  it("returns 0 when counter throws (no upstream configured)", async () => {
    const { push } = fakePusher();
    const q = new PushQueue({
      push,
      debounceMs: 100,
      backoffMs: [],
      countUnpushed: async () => {
        throw new Error("no upstream");
      },
    });
    expect(await q.unpushedCommits()).toBe(0);
    await q.close();
  });

  it("returns 0 when counter not provided", async () => {
    const { push } = fakePusher();
    const q = new PushQueue({ push, debounceMs: 100, backoffMs: [] });
    expect(await q.unpushedCommits()).toBe(0);
    await q.close();
  });
});
```

- [ ] **Step 2: Run — expect fail (`countUnpushed` unknown; method missing)**

```
npx vitest run tests/unit/backend/vault/git/push-queue.test.ts -t "unpushedCommits"
```

Expected: FAIL.

- [ ] **Step 3: Extend config + add method**

Edit `src/backend/vault/git/push-queue.ts`:

```ts
export interface PushQueueConfig {
  push: () => Promise<void>;
  countUnpushed?: () => Promise<number>;
  debounceMs: number;
  backoffMs: readonly number[];
}
```

Inside `PushQueue`:

```ts
  async unpushedCommits(): Promise<number> {
    if (!this.cfg.countUnpushed) return 0;
    try {
      return await this.cfg.countUnpushed();
    } catch {
      return 0;
    }
  }
```

- [ ] **Step 4: Run — expect pass**

```
npx vitest run tests/unit/backend/vault/git/push-queue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/backend/vault/git/push-queue.ts tests/unit/backend/vault/git/push-queue.test.ts
git commit -m "feat(vault-sync): PushQueue unpushedCommits()"
```

---

## Task 7: `syncFromRemote` — pull --rebase --autostash

**Goal:** Pull the vault, classify outcome as `success | offline | conflict`, collect `changedPaths` (for reindex). Never throws on offline/conflict.

**Files:**

- Create: `src/backend/vault/git/pull.ts`
- Create: `tests/unit/backend/vault/git/pull.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/backend/vault/git/pull.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";
import { syncFromRemote } from "../../../../../src/backend/vault/git/pull.js";

async function setupOriginAndClone(): Promise<{
  origin: string;
  clone: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pull-test-"));
  const origin = join(dir, "origin.git");
  const clone = join(dir, "clone");
  await mkdir(origin);
  await simpleGit().env(scrubGitEnv()).cwd(origin).init(true);
  await simpleGit().env(scrubGitEnv()).clone(origin, clone);
  const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
  await git.addConfig("user.email", "t@x", false, "local");
  await git.addConfig("user.name", "t", false, "local");
  await writeFile(join(clone, "first.md"), "hello\n");
  await git.add("first.md");
  await git.commit("initial");
  await git.push("origin", "HEAD:main");
  return {
    origin,
    clone,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("syncFromRemote", () => {
  it("fast-forward returns changedPaths, not offline/conflict", async () => {
    const { origin, clone, cleanup } = await setupOriginAndClone();
    try {
      // Make a second clone, commit, push.
      const other = clone + "-other";
      await simpleGit().env(scrubGitEnv()).clone(origin, other);
      const og = simpleGit({ baseDir: other }).env(scrubGitEnv());
      await og.addConfig("user.email", "t@x", false, "local");
      await og.addConfig("user.name", "t", false, "local");
      await writeFile(join(other, "added.md"), "new\n");
      await og.add("added.md");
      await og.commit("add file");
      await og.push("origin", "HEAD:main");

      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      const result = await syncFromRemote({ git });
      expect(result.offline).toBe(false);
      expect(result.conflict).toBe(false);
      expect(result.changedPaths).toContain("added.md");
    } finally {
      await cleanup();
    }
  });

  it("up-to-date returns empty changedPaths", async () => {
    const { clone, cleanup } = await setupOriginAndClone();
    try {
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      const result = await syncFromRemote({ git });
      expect(result.offline).toBe(false);
      expect(result.conflict).toBe(false);
      expect(result.changedPaths).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("rebase conflict → conflict=true, rebase aborted, working tree clean", async () => {
    const { origin, clone, cleanup } = await setupOriginAndClone();
    try {
      // Remote commit modifies first.md.
      const other = clone + "-other";
      await simpleGit().env(scrubGitEnv()).clone(origin, other);
      const og = simpleGit({ baseDir: other }).env(scrubGitEnv());
      await og.addConfig("user.email", "t@x", false, "local");
      await og.addConfig("user.name", "t", false, "local");
      await writeFile(join(other, "first.md"), "remote-change\n");
      await og.add("first.md");
      await og.commit("remote");
      await og.push("origin", "HEAD:main");

      // Local conflicting commit on the same file.
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      await writeFile(join(clone, "first.md"), "local-change\n");
      await git.add("first.md");
      await git.commit("local");

      const result = await syncFromRemote({ git });
      expect(result.conflict).toBe(true);
      expect(result.offline).toBe(false);
      const status = await git.status();
      expect(status.files).toHaveLength(0); // clean working tree
    } finally {
      await cleanup();
    }
  });

  it("network failure → offline=true, no throw", async () => {
    const { clone, cleanup } = await setupOriginAndClone();
    try {
      const git = simpleGit({ baseDir: clone }).env(scrubGitEnv());
      // Point origin at a bogus URL.
      await git.remote(["set-url", "origin", "/tmp/does-not-exist-xyz"]);
      const result = await syncFromRemote({ git });
      expect(result.offline).toBe(true);
      expect(result.conflict).toBe(false);
      expect(result.changedPaths).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run — expect fail**

```
npx vitest run tests/unit/backend/vault/git/pull.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement `syncFromRemote`**

Create `src/backend/vault/git/pull.ts`:

```ts
import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";

export interface SyncFromRemoteConfig {
  git: SimpleGit;
}

export interface SyncResult {
  offline: boolean;
  conflict: boolean;
  /** Paths changed by the pull (git-relative, forward-slash). */
  changedPaths: string[];
}

/**
 * Runs `git pull --rebase --autostash`. Classifies failures rather than
 * throwing. Rebase conflicts abort via `git rebase --abort` so the working
 * tree returns to the pre-pull HEAD. Network / auth failures surface as
 * `offline: true`. Caller decides whether to serve local stale data.
 */
export async function syncFromRemote(
  cfg: SyncFromRemoteConfig,
): Promise<SyncResult> {
  // Short-circuit when no origin is configured — pull would throw
  // "no tracking information".
  const remotes = await cfg.git.getRemotes(true);
  if (!remotes.some((r) => r.name === "origin")) {
    return { offline: false, conflict: false, changedPaths: [] };
  }

  const preHead = await resolveHead(cfg.git);

  try {
    await cfg.git.pull("origin", undefined, {
      "--rebase": null,
      "--autostash": null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/CONFLICT|could not apply|Merge conflict|rebase.*conflict/i.test(msg)) {
      try {
        await cfg.git.raw(["rebase", "--abort"]);
      } catch (abortErr) {
        logger.error(
          `vault: rebase --abort failed after conflict: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
        );
      }
      return { offline: false, conflict: true, changedPaths: [] };
    }
    // Treat everything else as offline/transient — network, auth, no
    // upstream, host unreachable, etc.
    logger.warn(`vault: pull failed, serving local: ${msg}`);
    return { offline: true, conflict: false, changedPaths: [] };
  }

  const postHead = await resolveHead(cfg.git);
  if (!preHead || !postHead || preHead === postHead) {
    return { offline: false, conflict: false, changedPaths: [] };
  }
  const diff = await cfg.git.raw([
    "diff",
    "--name-only",
    `${preHead}..${postHead}`,
  ]);
  const changedPaths = diff
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { offline: false, conflict: false, changedPaths };
}

async function resolveHead(git: SimpleGit): Promise<string | null> {
  try {
    const sha = await git.raw(["rev-parse", "HEAD"]);
    return sha.trim();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run — expect pass**

```
npx vitest run tests/unit/backend/vault/git/pull.test.ts
```

Expected: PASS (4/4). Note: if vitest complains about the `[2]` / `[0]` fake-clone tempdir, each test creates its own `mkdtemp`, so isolation holds.

- [ ] **Step 5: Commit**

```
git add src/backend/vault/git/pull.ts tests/unit/backend/vault/git/pull.test.ts
git commit -m "feat(vault-sync): syncFromRemote pull --rebase --autostash"
```

---

## Task 8: `reconcileDirty` — post-crash recovery commit

**Goal:** On backend startup, collapse any dirty tracked memory markdown files into a single `AB-Action: reconcile` commit before serving. Uses the same `GitOpsImpl.stageAndCommit` so we inherit the mutex + scoped-commit invariants.

**Files:**

- Create: `src/backend/vault/git/reconcile.ts`
- Create: `tests/unit/backend/vault/git/reconcile.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/backend/vault/git/reconcile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { scrubGitEnv } from "../../../../../src/backend/vault/git/env.js";
import { GitOpsImpl } from "../../../../../src/backend/vault/git/git-ops.js";
import { reconcileDirty } from "../../../../../src/backend/vault/git/reconcile.js";

async function makeRepo(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "reconcile-test-"));
  const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
  await git.init();
  await git.addConfig("user.email", "t@x", false, "local");
  await git.addConfig("user.name", "t", false, "local");
  // Ignore a runtime subtree to prove reconcile skips gitignored files.
  await writeFile(join(root, ".gitignore"), ".agent-brain/\n");
  await git.add(".gitignore");
  await git.commit("init");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("reconcileDirty", () => {
  it("collapses dirty tracked memory markdown into one reconcile commit", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      const ops = new GitOpsImpl({ root });

      // Create + commit two memory files so they're tracked.
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(join(root, "workspaces/ws1/memories/a.md"), "v1-a\n");
      await writeFile(join(root, "workspaces/ws1/memories/b.md"), "v1-b\n");
      await git.add([
        "workspaces/ws1/memories/a.md",
        "workspaces/ws1/memories/b.md",
      ]);
      await git.commit("seed");

      // Now dirty them outside git — simulates post-crash state.
      await writeFile(join(root, "workspaces/ws1/memories/a.md"), "v2-a\n");
      await writeFile(join(root, "workspaces/ws1/memories/b.md"), "v2-b\n");

      await reconcileDirty({ git, ops });

      const log = await git.log();
      expect(log.latest?.message).toMatch(/reconcile/i);
      const showFiles = await git.raw([
        "show",
        "--name-only",
        "--pretty=format:",
        "HEAD",
      ]);
      const files = showFiles
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(files).toEqual(
        expect.arrayContaining([
          "workspaces/ws1/memories/a.md",
          "workspaces/ws1/memories/b.md",
        ]),
      );
    } finally {
      await cleanup();
    }
  });

  it("no-op when tree clean", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      const ops = new GitOpsImpl({ root });
      const before = (await git.log()).total;
      await reconcileDirty({ git, ops });
      const after = (await git.log()).total;
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it("ignores untracked files and gitignored dirty files", async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const git = simpleGit({ baseDir: root }).env(scrubGitEnv());
      const ops = new GitOpsImpl({ root });

      await mkdir(join(root, ".agent-brain"), { recursive: true });
      await writeFile(join(root, ".agent-brain/state.json"), "{}");
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/new.md"),
        "untracked\n",
      );

      const before = (await git.log()).total;
      await reconcileDirty({ git, ops });
      const after = (await git.log()).total;
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run — expect fail**

```
npx vitest run tests/unit/backend/vault/git/reconcile.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `reconcileDirty`**

Create `src/backend/vault/git/reconcile.ts`:

```ts
import type { SimpleGit } from "simple-git";
import { logger } from "../../../utils/logger.js";
import type { GitOps } from "./types.js";

export interface ReconcileConfig {
  git: SimpleGit;
  ops: GitOps;
}

const MEMORY_PATH_RE =
  /^(workspaces\/[^/]+\/memories\/|project\/memories\/|users\/[^/]+\/memories\/).+\.md$/;

/**
 * Recovers from a crash between "markdown write succeeded" and "git commit
 * landed" in Phase 4a. Collects dirty tracked memory markdown files and
 * folds them into a single commit with trailer `AB-Action: reconcile`.
 *
 * Untracked files are ignored (requires validation; defer to Phase 5
 * watcher). Non-memory dirty files are also ignored — operator edits to
 * README etc. should not be auto-committed by agent-brain on startup.
 */
export async function reconcileDirty(cfg: ReconcileConfig): Promise<void> {
  if (!cfg.ops.enabled) return;
  const status = await cfg.git.status();
  const candidates = [
    ...status.modified,
    ...status.not_added,
    ...status.deleted,
  ].filter((p) => MEMORY_PATH_RE.test(p));
  if (candidates.length === 0) return;

  try {
    await cfg.ops.stageAndCommit(
      candidates,
      "[agent-brain] reconcile: post-crash recovery",
      {
        action: "reconcile",
        actor: "agent-brain",
        reason: "post-crash-recovery",
      },
    );
  } catch (err) {
    logger.error(
      `vault reconcile commit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

- [ ] **Step 4: Extend `CommitAction` to include `"reconcile"`**

Edit `src/backend/vault/git/trailers.ts` (or wherever `CommitAction` is defined — check `types.ts` first):

```ts
export type CommitAction =
  | "created"
  | "updated"
  | "archived"
  | "verified"
  | "commented"
  | "flagged"
  | "unflagged"
  | "related"
  | "unrelated"
  | "workspace_upsert"
  | "reconcile";
```

- [ ] **Step 5: Update trailer-formatter test if it enumerates actions**

Check `tests/unit/backend/vault/git/trailers.test.ts` for an enumeration assertion and add `"reconcile"` if needed.

- [ ] **Step 6: Run tests**

```
npx vitest run tests/unit/backend/vault/git/reconcile.test.ts tests/unit/backend/vault/git/trailers.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/backend/vault/git/reconcile.ts src/backend/vault/git/types.ts tests/unit/backend/vault/git/reconcile.test.ts tests/unit/backend/vault/git/trailers.test.ts
git commit -m "feat(vault-sync): reconcileDirty post-crash recovery commit"
```

---

## Task 9: `diffReindex` — refresh lance after pull

**Goal:** Given a list of changed paths returned by `syncFromRemote`, parse each memory markdown file, compare `content_hash` against the Phase 3 lance row, and:

- new hash → re-embed via the embedding provider + full upsert
- same hash → metadata-only upsert (no re-embed)
- parse failure → increment `parse_errors`, skip, continue

The embedding call is injected so unit tests use a deterministic fake.

**Files:**

- Create: `src/backend/vault/session-start.ts` (holds `diffReindex` for now; `runSessionStart` added in Task 10)
- Create: `tests/unit/backend/vault/session-start.test.ts`
- Modify: `src/backend/vault/vector/lance-index.ts` — add `getContentHash(id)` lookup

- [ ] **Step 1: Add `getContentHash` to vector index**

Edit `src/backend/vault/vector/lance-index.ts`. Add method:

```ts
  async getContentHash(id: string): Promise<string | null> {
    const rows = await this.table
      .query()
      .where(`id = '${id.replace(/'/g, "''")}'`)
      .select(["content_hash"])
      .limit(1)
      .toArray();
    if (rows.length === 0) return null;
    return String(rows[0].content_hash);
  }
```

Add unit coverage in `tests/unit/backend/vault/vector/lance-index.test.ts`:

```ts
it("getContentHash returns stored hash", async () => {
  const { index, cleanup } = await makeIndex();
  try {
    await index.upsert([{ ...baseRow("m1"), content_hash: "h1" }]);
    expect(await index.getContentHash("m1")).toBe("h1");
    expect(await index.getContentHash("missing")).toBeNull();
  } finally {
    await cleanup();
  }
});
```

(Use the file's existing `makeIndex` / `baseRow` helpers; they already exist — check imports.)

Run: `npx vitest run tests/unit/backend/vault/vector/lance-index.test.ts -t "getContentHash"` — PASS.

- [ ] **Step 2: Write failing `diffReindex` tests**

Create `tests/unit/backend/vault/session-start.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultVectorIndex } from "../../../../src/backend/vault/vector/lance-index.js";
import { diffReindex } from "../../../../src/backend/vault/session-start.js";
import { serializeMemoryFile } from "../../../../src/backend/vault/parser/memory-parser.js";

const DIMS = 768;

async function setup(): Promise<{
  root: string;
  index: VaultVectorIndex;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "reindex-test-"));
  const index = await VaultVectorIndex.create({ root, dims: DIMS });
  return {
    root,
    index,
    cleanup: async () => {
      await index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fakeMemoryMarkdown(id: string, body: string): string {
  return serializeMemoryFile({
    frontmatter: {
      id,
      title: `t-${id}`,
      type: "fact",
      scope: "workspace",
      workspace_id: "ws1",
      user_id: null,
      project_id: "p1",
      author: "a",
      source: null,
      tags: null,
      version: 1,
      created_at: "2026-04-22T00:00:00Z",
      updated_at: "2026-04-22T00:00:00Z",
      verified_at: null,
      archived_at: null,
      embedding_model: null,
      embedding_dimensions: DIMS,
      flags: [],
    },
    body,
    comments: [],
    relationships: [],
  });
}

async function writeMemory(
  root: string,
  path: string,
  id: string,
  body: string,
): Promise<void> {
  const abs = join(root, path);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, fakeMemoryMarkdown(id, body));
}

describe("diffReindex", () => {
  it("re-embeds when content hash changed", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let calls = 0;
      const embed = async (text: string) => {
        calls += 1;
        return new Array(DIMS).fill(text.length / 100);
      };
      await writeMemory(root, "workspaces/ws1/memories/m1.md", "m1", "body-v1");
      const r1 = await diffReindex({
        paths: ["workspaces/ws1/memories/m1.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(r1.parseErrors).toBe(0);
      expect(calls).toBe(1);

      await writeMemory(root, "workspaces/ws1/memories/m1.md", "m1", "body-v2");
      const r2 = await diffReindex({
        paths: ["workspaces/ws1/memories/m1.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(r2.parseErrors).toBe(0);
      expect(calls).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("skips re-embed when content hash unchanged", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let calls = 0;
      const embed = async (text: string) => {
        calls += 1;
        return new Array(DIMS).fill(text.length / 100);
      };
      await writeMemory(
        root,
        "workspaces/ws1/memories/m1.md",
        "m1",
        "body-stable",
      );
      await diffReindex({
        paths: ["workspaces/ws1/memories/m1.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(calls).toBe(1);
      await diffReindex({
        paths: ["workspaces/ws1/memories/m1.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(calls).toBe(1); // skipped — same hash
    } finally {
      await cleanup();
    }
  });

  it("counts parse errors without aborting", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const embed = async () => new Array(DIMS).fill(0.1);
      await writeMemory(root, "workspaces/ws1/memories/good.md", "good", "ok");
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/bad.md"),
        ":: not YAML ::\n",
      );
      const r = await diffReindex({
        paths: [
          "workspaces/ws1/memories/good.md",
          "workspaces/ws1/memories/bad.md",
        ],
        root,
        vectorIndex: index,
        embed,
      });
      expect(r.parseErrors).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("skips non-memory paths", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let calls = 0;
      const embed = async () => {
        calls += 1;
        return new Array(DIMS).fill(0.1);
      };
      const r = await diffReindex({
        paths: [".gitignore", "README.md", "docs/x.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(r.parseErrors).toBe(0);
      expect(calls).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
```

Adjust `serializeMemoryFile` import path if the parser exports differ — check `src/backend/vault/parser/memory-parser.ts` for the exact exported fn name (may be `serialize` / `serializeMemoryFile` / similar) and `MemoryFile` shape.

- [ ] **Step 3: Run — expect fail**

```
npx vitest run tests/unit/backend/vault/session-start.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 4: Implement `diffReindex`**

Create `src/backend/vault/session-start.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseMemoryFile } from "./parser/memory-parser.js";
import type { VaultVectorIndex, IndexRow } from "./vector/lance-index.js";
import { logger } from "../../utils/logger.js";

const MEMORY_PATH_RE =
  /^(workspaces\/[^/]+\/memories\/|project\/memories\/|users\/[^/]+\/memories\/).+\.md$/;

export type Embedder = (text: string) => Promise<number[]>;

export interface DiffReindexConfig {
  paths: string[];
  root: string;
  vectorIndex: VaultVectorIndex;
  embed: Embedder;
}

export interface DiffReindexResult {
  parseErrors: number;
}

export async function diffReindex(
  cfg: DiffReindexConfig,
): Promise<DiffReindexResult> {
  let parseErrors = 0;
  for (const rel of cfg.paths) {
    if (!MEMORY_PATH_RE.test(rel)) continue;
    const abs = join(cfg.root, rel);
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (err) {
      // File deleted by the pull (e.g. remote deleted a memory via merge).
      // Skip silently — phase 4b does not handle remote deletions.
      logger.debug(
        `diffReindex: skip unreadable ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    let parsed;
    try {
      parsed = parseMemoryFile(raw);
    } catch {
      parseErrors += 1;
      continue;
    }
    const fm = parsed.frontmatter;
    const newHash = sha256(parsed.body);
    const existingHash = await cfg.vectorIndex.getContentHash(fm.id);

    if (existingHash === newHash) {
      await cfg.vectorIndex.upsert([buildRow(fm, existingHash, undefined)]);
      continue;
    }
    const embedding = await cfg.embed(parsed.body);
    await cfg.vectorIndex.upsert([buildRow(fm, newHash, embedding)]);
  }
  return { parseErrors };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function buildRow(
  fm: {
    id: string;
    project_id: string;
    workspace_id: string | null;
    scope: "workspace" | "user" | "project";
    author: string;
    title: string;
    archived_at: string | null;
  },
  contentHash: string,
  embedding: number[] | undefined,
): IndexRow {
  return {
    id: fm.id,
    project_id: fm.project_id,
    workspace_id: fm.workspace_id,
    scope: fm.scope,
    author: fm.author,
    title: fm.title,
    archived: fm.archived_at !== null,
    content_hash: contentHash,
    vector: embedding ?? [],
  };
}
```

**Note:** `vector: []` path relies on `VaultVectorIndex.upsert` accepting a meta-only update. If Phase 3 requires non-empty vectors in `upsert`, the unchanged-hash branch must call `upsertMetaOnly` instead — check the existing lance-index API. If `upsertMetaOnly` is a distinct method, swap the unchanged-hash line for:

```ts
await cfg.vectorIndex.upsertMetaOnly(fm);
continue;
```

- [ ] **Step 5: Fix parser types as needed**

Adjust `parseMemoryFile` call signature to match the Phase 1 parser. If the parser returns `{ frontmatter, body, comments, relationships }` with different field names, update `diffReindex` accordingly. Check `src/backend/vault/parser/memory-parser.ts` for the canonical export.

- [ ] **Step 6: Run — expect pass**

```
npx vitest run tests/unit/backend/vault/session-start.test.ts tests/unit/backend/vault/vector/lance-index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/backend/vault/session-start.ts src/backend/vault/vector/lance-index.ts tests/unit/backend/vault/session-start.test.ts tests/unit/backend/vault/vector/lance-index.test.ts
git commit -m "feat(vault-sync): diffReindex + VaultVectorIndex.getContentHash"
```

---

## Task 10: `runSessionStart` orchestrator + `VaultBackend.sessionStart`

**Goal:** Tie `syncFromRemote`, `diffReindex`, and `pushQueue` together. Return `BackendSessionStartMeta`.

**Files:**

- Modify: `src/backend/vault/session-start.ts` (add orchestrator)
- Modify: `src/backend/vault/index.ts` (wire + real `sessionStart`)
- Modify: `tests/unit/backend/vault/session-start.test.ts` (add orchestrator tests)

- [ ] **Step 1: Write failing orchestrator test**

Append to `tests/unit/backend/vault/session-start.test.ts`:

```ts
import { runSessionStart } from "../../../../src/backend/vault/session-start.js";

function fakeSync(result: {
  offline?: boolean;
  conflict?: boolean;
  changedPaths?: string[];
}) {
  return async () => ({
    offline: result.offline ?? false,
    conflict: result.conflict ?? false,
    changedPaths: result.changedPaths ?? [],
  });
}

function fakePushQueue(unpushed: number | (() => Promise<number>)) {
  return {
    unpushedCommits: async () =>
      typeof unpushed === "number" ? unpushed : await unpushed(),
    request: () => {},
  };
}

describe("runSessionStart", () => {
  it("all-happy returns empty meta", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({}),
        pushQueue: fakePushQueue(0),
      });
      expect(meta).toEqual({});
    } finally {
      await cleanup();
    }
  });

  it("offline surfaces in meta", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({ offline: true }),
        pushQueue: fakePushQueue(0),
      });
      expect(meta.offline).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("conflict surfaces in meta", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({ conflict: true }),
        pushQueue: fakePushQueue(0),
      });
      expect(meta.pull_conflict).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("unpushed > 0 surfaces", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({}),
        pushQueue: fakePushQueue(3),
      });
      expect(meta.unpushed_commits).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("parse errors propagate from diffReindex", async () => {
    const { root, index, cleanup } = await setup();
    try {
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/bad.md"),
        ":: not YAML ::\n",
      );
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({
          changedPaths: ["workspaces/ws1/memories/bad.md"],
        }),
        pushQueue: fakePushQueue(0),
      });
      expect(meta.parse_errors).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("kicks pushQueue.request() after collecting meta", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let kicked = 0;
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({}),
        pushQueue: {
          unpushedCommits: async () => 2,
          request: () => {
            kicked += 1;
          },
        },
      });
      expect(kicked).toBe(1);
      expect(meta.unpushed_commits).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run — expect fail**

```
npx vitest run tests/unit/backend/vault/session-start.test.ts -t "runSessionStart"
```

Expected: FAIL.

- [ ] **Step 3: Implement orchestrator**

Append to `src/backend/vault/session-start.ts`:

```ts
import type { BackendSessionStartMeta } from "../types.js";
import type { SyncResult } from "./git/pull.js";

export interface PushQueueHandle {
  unpushedCommits(): Promise<number>;
  request(): void;
}

export interface RunSessionStartConfig {
  root: string;
  vectorIndex: VaultVectorIndex;
  embed: Embedder;
  syncFromRemote: () => Promise<SyncResult>;
  pushQueue: PushQueueHandle;
}

export async function runSessionStart(
  cfg: RunSessionStartConfig,
): Promise<BackendSessionStartMeta> {
  const meta: BackendSessionStartMeta = {};
  const pull = await cfg.syncFromRemote();
  if (pull.offline) meta.offline = true;
  if (pull.conflict) meta.pull_conflict = true;

  let parseErrors = 0;
  if (pull.changedPaths.length > 0) {
    const result = await diffReindex({
      paths: pull.changedPaths,
      root: cfg.root,
      vectorIndex: cfg.vectorIndex,
      embed: cfg.embed,
    });
    parseErrors = result.parseErrors;
  }
  if (parseErrors > 0) meta.parse_errors = parseErrors;

  const unpushed = await cfg.pushQueue.unpushedCommits();
  if (unpushed > 0) meta.unpushed_commits = unpushed;
  cfg.pushQueue.request(); // kick drain

  return meta;
}
```

- [ ] **Step 4: Run**

```
npx vitest run tests/unit/backend/vault/session-start.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/backend/vault/session-start.ts tests/unit/backend/vault/session-start.test.ts
git commit -m "feat(vault-sync): runSessionStart orchestrator"
```

---

## Task 11: Wire PushQueue + reconcile + sessionStart into `VaultBackend`

**Goal:** Replace the Task-1 stub `sessionStart` with the real orchestrator. Add config fields for `remoteUrl`, `pushDebounceMs`, `pushBackoffMs`. Construct `PushQueue`, hook `afterCommit`, run `ensureRemote` and `reconcileDirty` at backend create. Extend `close()` to drain the queue.

**Files:**

- Modify: `src/backend/vault/index.ts`
- Modify: `src/backend/factory.ts`
- Test: `tests/integration/vault/two-clone-sync.test.ts` comes in Task 13; this task verified via existing contract/unit suites.

- [ ] **Step 1: Extend `VaultBackendConfig`**

In `src/backend/vault/index.ts`:

```ts
export interface VaultBackendConfig {
  root: string;
  embeddingDimensions: number;
  trackUsersInGit?: boolean;
  remoteUrl?: string;
  pushDebounceMs?: number;
  pushBackoffMs?: readonly number[];
  /**
   * Dependency-injected embedder used for diffReindex on pull.
   * Defaults to a runtime provider-based embedder; tests inject a fake.
   */
  embed?: Embedder;
}
```

Add `Embedder` import from `./session-start.js`.

- [ ] **Step 2: Wire primitives in `VaultBackend.create`**

Replace the body of `VaultBackend.create`:

```ts
  static async create(cfg: VaultBackendConfig): Promise<VaultBackend> {
    await mkdir(cfg.root, { recursive: true });
    const trackUsersInGit = cfg.trackUsersInGit ?? false;
    await ensureVaultGit({
      root: cfg.root,
      trackUsers: trackUsersInGit,
    });
    const git = simpleGit({ baseDir: cfg.root }).env(scrubGitEnv());
    await ensureRemote({ git, remoteUrl: cfg.remoteUrl });

    const gitOps: GitOps = new GitOpsImpl({ root: cfg.root });
    await reconcileDirty({ git, ops: gitOps });

    const vectorIndex = await VaultVectorIndex.create({
      root: cfg.root,
      dims: cfg.embeddingDimensions,
    });

    const debounceMs = cfg.pushDebounceMs ?? 5000;
    const backoffMs = cfg.pushBackoffMs ?? [5000, 30000, 300000, 1800000];
    const pushQueue = new PushQueue({
      debounceMs,
      backoffMs,
      push: async () => {
        await git.push("origin", "HEAD:main");
      },
      countUnpushed: async () => {
        try {
          const out = await git.raw([
            "rev-list",
            "--count",
            "@{u}..HEAD",
          ]);
          return Number(out.trim()) || 0;
        } catch {
          return 0;
        }
      },
    });
    // Fire push attempt after every successful commit.
    if (gitOps.enabled) {
      gitOps.afterCommit = () => pushQueue.request();
    }

    const memoryRepo = await VaultMemoryRepository.create({
      root: cfg.root,
      index: vectorIndex,
      gitOps,
      trackUsersInGit,
    });

    const embed = cfg.embed ?? defaultEmbedder(cfg.embeddingDimensions);

    return new VaultBackend(
      memoryRepo,
      vectorIndex,
      cfg.root,
      gitOps,
      trackUsersInGit,
      git,
      pushQueue,
      embed,
    );
  }
```

Update imports (`simpleGit`, `scrubGitEnv`, `ensureRemote`, `reconcileDirty`, `PushQueue`, `GitOpsImpl`).

Add `defaultEmbedder` helper in the same file:

```ts
import { getEmbeddingProvider } from "../../providers/embedding/index.js";

function defaultEmbedder(dims: number): Embedder {
  const provider = getEmbeddingProvider();
  return async (text: string) => {
    const vec = await provider.embed(text);
    if (vec.length !== dims) {
      throw new Error(
        `vault embed: provider returned ${vec.length} dims, expected ${dims}`,
      );
    }
    return vec;
  };
}
```

If `getEmbeddingProvider` is not already the canonical factory, inspect `src/providers/embedding/index.ts` and use the correct function. Pick the existing startup-time provider resolution used by `MemoryService` to keep parity.

- [ ] **Step 3: Extend constructor to store new deps**

```ts
  private constructor(
    memoryRepo: MemoryRepository,
    private readonly vectorIndex: VaultVectorIndex,
    private readonly root: string,
    gitOps: GitOps,
    trackUsersInGit: boolean,
    private readonly git: SimpleGit,
    private readonly pushQueue: PushQueue,
    private readonly embed: Embedder,
  ) {
    // existing body unchanged
  }
```

Add `SimpleGit` + `PushQueue` imports.

- [ ] **Step 4: Replace `sessionStart` stub with real orchestrator**

```ts
  async sessionStart(): Promise<BackendSessionStartMeta> {
    return runSessionStart({
      root: this.root,
      vectorIndex: this.vectorIndex,
      embed: this.embed,
      syncFromRemote: () => syncFromRemote({ git: this.git }),
      pushQueue: {
        unpushedCommits: () => this.pushQueue.unpushedCommits(),
        request: () => this.pushQueue.request(),
      },
    });
  }
```

- [ ] **Step 5: Extend `close()`**

```ts
  async close(): Promise<void> {
    await this.pushQueue.close();
    await this.vectorIndex.close();
  }
```

- [ ] **Step 6: Plumb env var through factory**

Edit `src/backend/factory.ts`. Where `VaultBackend.create` is called, pass:

```ts
return VaultBackend.create({
  root: vaultRoot,
  embeddingDimensions: cfg.embeddingDimensions,
  trackUsersInGit: cfg.trackUsersInGit,
  remoteUrl: process.env.AGENT_BRAIN_VAULT_REMOTE_URL,
});
```

Preserve existing fields; only add `remoteUrl`.

- [ ] **Step 7: Run full unit + contract suites**

```
npm run test:unit
```

Expected: PASS. Debug any regression in `tests/contract/repositories/*-git.test.ts` — most likely culprit is a test that doesn't pass `remoteUrl` (fine — env var absent, no push queue activity because no remote).

- [ ] **Step 8: Commit**

```
git add src/backend/vault/index.ts src/backend/factory.ts
git commit -m "feat(vault-sync): wire PushQueue, ensureRemote, reconcileDirty, sessionStart"
```

---

## Task 12: Service + tool — merge backend meta into envelope

**Goal:** `MemoryService.sessionStart` awaits `backend.sessionStart()` once and merges fields into `result.meta`. No changes needed in the MCP tool (envelope passes through untouched).

**Files:**

- Modify: `src/services/memory-service.ts`
- Test: `tests/integration/session-start.test.ts` (add assertions)

- [ ] **Step 1: Add `StorageBackend` dependency to MemoryService if not already injected**

Inspect the `MemoryService` constructor / factory. If it already receives the backend, skip. If it only receives individual repos, add a `backend: StorageBackend` param (propagate via `src/server.ts` / `MemoryService.create`).

- [ ] **Step 2: Add failing test**

In `tests/integration/session-start.test.ts`, add:

```ts
it("envelope meta includes backend fields (vault, offline=true simulated)", async () => {
  // Uses a fake backend that returns { offline: true, unpushed_commits: 2 }.
  const backend = makeFakeBackend({ offline: true, unpushed_commits: 2 });
  const service = new MemoryService(/* deps + */ backend);
  const envelope = await service.sessionStart("ws1", "alice");
  expect(envelope.meta.offline).toBe(true);
  expect(envelope.meta.unpushed_commits).toBe(2);
});
```

Add `makeFakeBackend` helper (inline or in `tests/helpers.ts`) that wraps the existing pg test backend with an override for `sessionStart`.

Run: `npx vitest run tests/integration/session-start.test.ts -t "backend fields"` — FAIL.

- [ ] **Step 3: Wire merge in `MemoryService.sessionStart`**

Near the top of `sessionStart`, after workspace findOrCreate:

```ts
const backendMeta = await this.backend.sessionStart();
```

At the end, before return:

```ts
if (backendMeta.offline) result.meta.offline = true;
if (backendMeta.pull_conflict) result.meta.pull_conflict = true;
if (
  typeof backendMeta.unpushed_commits === "number" &&
  backendMeta.unpushed_commits > 0
) {
  result.meta.unpushed_commits = backendMeta.unpushed_commits;
}
if (
  typeof backendMeta.parse_errors === "number" &&
  backendMeta.parse_errors > 0
) {
  result.meta.parse_errors = backendMeta.parse_errors;
}
```

Extend the `result.meta` TypeScript type to accept these fields (find the existing `Envelope<MemorySummaryWithRelevance[]>` shape and widen the meta to include optional `offline`, `pull_conflict`, `unpushed_commits`, `parse_errors`).

- [ ] **Step 4: Run — PASS**

```
npx vitest run tests/integration/session-start.test.ts
```

Expected: PASS.

- [ ] **Step 5: Full suite**

```
npm run test:unit
```

- [ ] **Step 6: Commit**

```
git add src/services/memory-service.ts tests/integration/session-start.test.ts tests/helpers.ts
git commit -m "feat(vault-sync): merge backend sessionStart meta into envelope"
```

---

## Task 13: Server-boot smoke — vault backend with remote URL

**Goal:** Catch ESM/CJS interop on the new deps by booting the real server under `AGENT_BRAIN_BACKEND=vault` with a bare-repo remote.

**Files:**

- Modify: `tests/unit/server-boot.test.ts`

- [ ] **Step 1: Extend test**

Find the existing server-boot test. Add a case (inside the same `describe`):

```ts
it("boots under AGENT_BRAIN_BACKEND=vault with AGENT_BRAIN_VAULT_REMOTE_URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "server-boot-vault-"));
  const bare = join(dir, "origin.git");
  await mkdir(bare, { recursive: true });
  await simpleGit().env(scrubGitEnv()).cwd(bare).init(true);
  const vault = join(dir, "vault");
  try {
    const { stderr, exitCode } = await spawnServerWithEnv({
      AGENT_BRAIN_BACKEND: "vault",
      AGENT_BRAIN_VAULT_ROOT: vault,
      AGENT_BRAIN_VAULT_REMOTE_URL: bare,
    });
    expect(exitCode).toBe(0);
    // No error-level logs from push queue on boot.
    expect(stderr).not.toMatch(/vault push failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Use the existing `spawnServerWithEnv` helper if present; otherwise model it on the current server-boot spawn pattern (look up how the existing test uses `node --import tsx`).

Env var name for vault root: verify against `src/backend/factory.ts` — may be `AGENT_BRAIN_VAULT_ROOT` or similar.

- [ ] **Step 2: Run**

```
npx vitest run tests/unit/server-boot.test.ts
```

Expected: PASS. Note: this test exercises the full ESM import chain including `@lancedb/lancedb`.

- [ ] **Step 3: Commit**

```
git add tests/unit/server-boot.test.ts
git commit -m "test(vault-sync): server-boot smoke under vault backend + remote URL"
```

---

## Task 14: Two-clone integration test

**Goal:** End-to-end: two `VaultBackend` instances + bare origin. Cases: happy sync, non-conflicting concurrent writes, conflict envelope, offline mode.

**Files:**

- Create: `tests/integration/vault/two-clone-sync.test.ts`
- Modify: `tests/contract/repositories/_git-helpers.ts` — add shared `setupBareAndClones` helper

- [ ] **Step 1: Add helper**

In `tests/contract/repositories/_git-helpers.ts`:

```ts
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";

export async function setupBareAndTwoVaults(): Promise<{
  dir: string;
  bare: string;
  vaultA: string;
  vaultB: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "two-clone-"));
  const bare = join(dir, "origin.git");
  await mkdir(bare, { recursive: true });
  await simpleGit().env(scrubGitEnv()).cwd(bare).init(true);
  const vaultA = join(dir, "a");
  const vaultB = join(dir, "b");
  return {
    dir,
    bare,
    vaultA,
    vaultB,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: Write integration test**

Create `tests/integration/vault/two-clone-sync.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { setupBareAndTwoVaults } from "../../contract/repositories/_git-helpers.js";
import { VaultBackend } from "../../../src/backend/vault/index.js";

const DIMS = 768;

function fakeEmbed(): (text: string) => Promise<number[]> {
  return async () => new Array(DIMS).fill(0.01);
}

async function createBackend(
  root: string,
  remoteUrl: string,
): Promise<VaultBackend> {
  return VaultBackend.create({
    root,
    embeddingDimensions: DIMS,
    remoteUrl,
    pushDebounceMs: 10, // speed up tests
    pushBackoffMs: [50, 200],
    embed: fakeEmbed(),
  });
}

async function waitForUnpushedZero(backend: VaultBackend): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const meta = await backend.sessionStart();
    if (!meta.unpushed_commits || meta.unpushed_commits === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for unpushed_commits=0");
}

describe("vault two-clone sync", () => {
  it("write on A is visible on B after A pushes and B session-starts", async () => {
    const { bare, vaultA, vaultB, cleanup } = await setupBareAndTwoVaults();
    try {
      const a = await createBackend(vaultA, bare);
      // A must seed a first commit so origin has `main` branch.
      await a.memoryRepo.create(makeMemoryInput("m1"));
      await waitForUnpushedZero(a);

      const b = await createBackend(vaultB, bare);
      const meta = await b.sessionStart();
      expect(meta.pull_conflict).toBeUndefined();
      expect(meta.offline).toBeUndefined();

      const found = await b.memoryRepo.findById("m1");
      expect(found?.title).toBe("t-m1");

      await a.close();
      await b.close();
    } finally {
      await cleanup();
    }
  });

  it("non-conflicting concurrent writes merge cleanly", async () => {
    const { bare, vaultA, vaultB, cleanup } = await setupBareAndTwoVaults();
    try {
      const a = await createBackend(vaultA, bare);
      await a.memoryRepo.create(makeMemoryInput("seed"));
      await waitForUnpushedZero(a);

      const b = await createBackend(vaultB, bare);
      await b.sessionStart();

      await a.memoryRepo.create(makeMemoryInput("from-a"));
      await b.memoryRepo.create(makeMemoryInput("from-b"));
      await waitForUnpushedZero(a);

      const bMeta = await b.sessionStart();
      expect(bMeta.pull_conflict).toBeUndefined();
      await waitForUnpushedZero(b);

      const aMeta = await a.sessionStart();
      expect(aMeta.pull_conflict).toBeUndefined();

      expect(await a.memoryRepo.findById("from-b")).not.toBeNull();
      expect(await b.memoryRepo.findById("from-a")).not.toBeNull();

      await a.close();
      await b.close();
    } finally {
      await cleanup();
    }
  });

  it("conflicting writes on same file surface pull_conflict", async () => {
    const { bare, vaultA, vaultB, cleanup } = await setupBareAndTwoVaults();
    try {
      const a = await createBackend(vaultA, bare);
      await a.memoryRepo.create(makeMemoryInput("shared"));
      await waitForUnpushedZero(a);

      const b = await createBackend(vaultB, bare);
      await b.sessionStart();

      // Both mutate the SAME memory's title (frontmatter collision).
      await a.memoryRepo.update("shared", { title: "a-title" });
      await b.memoryRepo.update("shared", { title: "b-title" });
      await waitForUnpushedZero(a);

      const bMeta = await b.sessionStart();
      expect(bMeta.pull_conflict).toBe(true);

      await a.close();
      await b.close();
    } finally {
      await cleanup();
    }
  });

  it("offline mode: origin unreachable → meta.offline=true, writes still commit", async () => {
    const { bare, vaultA, cleanup } = await setupBareAndTwoVaults();
    try {
      const a = await createBackend(vaultA, bare);
      await a.memoryRepo.create(makeMemoryInput("seed"));
      await waitForUnpushedZero(a);
      // Break origin.
      await rm(bare, { recursive: true, force: true });

      await a.memoryRepo.create(makeMemoryInput("offline-write"));
      const meta = await a.sessionStart();
      expect(meta.offline).toBe(true);
      expect(meta.unpushed_commits ?? 0).toBeGreaterThan(0);

      await a.close();
    } finally {
      await cleanup();
    }
  });
});

function makeMemoryInput(id: string) {
  return {
    id,
    title: `t-${id}`,
    body: `body-${id}`,
    type: "fact" as const,
    scope: "workspace" as const,
    workspace_id: "ws1",
    user_id: null,
    project_id: "p1",
    author: "alice",
    embedding: new Array(DIMS).fill(0.1),
    // add any other required fields based on actual MemoryRepository.create signature
  };
}
```

Adjust `makeMemoryInput` to exactly match `VaultMemoryRepository.create` input. Inspect `src/backend/vault/repositories/memory-repository.ts` for the method signature — it is likely `CreateMemoryInput` with a specific shape. Replace `makeMemoryInput` body accordingly.

- [ ] **Step 3: Run**

```
npx vitest run tests/integration/vault/two-clone-sync.test.ts
```

Expected: PASS.

- [ ] **Step 4: If flaky on timing, tune**

The 10ms debounce + 50ms/200ms backoff is aggressive. If the test flakes in CI, raise to 100/500/2000. Single-flight + `waitForUnpushedZero` polling should absorb remaining jitter.

- [ ] **Step 5: Commit**

```
git add tests/integration/vault/two-clone-sync.test.ts tests/contract/repositories/_git-helpers.ts
git commit -m "test(vault-sync): two-clone integration coverage"
```

---

## Task 15: Docs + snippet alignment

**Goal:** Mark Phase 4 done on the design doc. No snippet changes required — `memory_session_start` tool signature unchanged; envelope `meta` is additive. Spec snippet refs to `meta.offline`/`meta.unpushed_commits` are informational, optional.

**Files:**

- Modify: `docs/superpowers/specs/2026-04-21-vault-backend-design.md`

- [ ] **Step 1: Tick phase 4 row**

Edit the "Phased rollout" table row for Phase 4 to reference the Phase 4a + 4b plans and note status:

```
| 4     | Git sync layer. Commit-on-write, pull-on-session_start, conflict handling. Two-clone integration test. **Done — 4a (#34), 4b (this PR).** |
```

- [ ] **Step 2: Commit**

```
git add docs/superpowers/specs/2026-04-21-vault-backend-design.md
git commit -m "docs(vault): mark Phase 4 git sync complete"
```

---

## Final verification

- [ ] **Typecheck**

```
npm run typecheck
```

Expected: PASS.

- [ ] **Full unit + integration**

```
npm run test:unit
```

Expected: PASS.

- [ ] **Lint + format**

```
npm run lint && npm run format
```

Expected: PASS.

- [ ] **Diff review**

```
git log --oneline main..HEAD
git diff main..HEAD --stat
```

Confirm every task produced its commit.

- [ ] **PR body**

Create PR titled `feat(vault): Phase 4b — git sync (push queue + pull on session_start)`. Body references spec `docs/superpowers/specs/2026-04-22-vault-backend-phase-4b-git-sync-design.md` and the Phase 4a handoff. Test plan lists all unit + integration suites added.

---

## Handoff notes

- The `content_hash` column on lance rows was seeded in Phase 3. The branch that skips re-embedding on hash-match relies on this; if a row predates the column (migration not run), the branch falls through to a full re-embed. Expected/safe.
- `gitOps.afterCommit` is opt-in per `GitOps` instance. Unit tests that construct `GitOpsImpl` directly without wiring `afterCommit` remain valid (hook is undefined, nothing fires).
- The push queue is a process-local, best-effort primitive. If the process is SIGKILLed between commit and push, reconciliation on next startup recovers _dirty working tree_ state only — committed-but-unpushed commits remain and get drained on the next `sessionStart`'s `pushQueue.request()` kick, per Task 11's wiring.
- Frontmatter-level merge conflicts are deferred to Phase 4c's smart merge driver. Phase 4b only surfaces the condition; users resolve manually (Obsidian edit + commit, or `git rebase --continue` from CLI).
