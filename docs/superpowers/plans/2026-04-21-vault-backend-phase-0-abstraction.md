# Vault Backend Phase 0 — StorageBackend Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `StorageBackend` abstraction that wraps the 8 existing repository interfaces so the Postgres backend is selected via factory rather than wired directly in `server.ts`. No behavior change. Unblocks later phases that will add a `VaultBackend` implementation.

**Architecture:** Introduce `src/backend/` tree: (a) `types.ts` declares a `StorageBackend` interface that bundles all repositories plus a `close()` lifecycle hook; (b) `postgres/index.ts` wraps the existing `Drizzle*Repository` classes in a `PostgresBackend` class; (c) `factory.ts` reads `AGENT_BRAIN_BACKEND` and returns the configured backend. `server.ts` replaces its 8 ad-hoc `new DrizzleXRepository(db)` lines with a single `await createBackend(config)` call and destructures repos from the result. Scheduler wiring stays pg-specific via a type guard (the scheduler uses pg advisory locks; vault won't need them).

**Tech Stack:** TypeScript, drizzle-orm, postgres-js, zod, vitest.

**Spec reference:** `docs/superpowers/specs/2026-04-21-vault-backend-design.md`

---

## File Structure

**Create:**

- `src/backend/types.ts` — `StorageBackend` interface + `BackendName` string literal union
- `src/backend/postgres/index.ts` — `PostgresBackend` class implementing `StorageBackend`
- `src/backend/factory.ts` — `createBackend(config)` factory
- `tests/unit/backend/factory.test.ts` — factory unit tests

**Modify:**

- `src/config.ts` — add `backend` field to config schema (zod enum, `postgres` default)
- `src/server.ts` — replace repo construction with `createBackend()`, destructure repos from result, move `db.$client.end()` into `PostgresBackend.close()`
- `.env.example` — document `AGENT_BRAIN_BACKEND`

**Unchanged (imported by new code):**

- `src/repositories/types.ts` — repo interfaces (already clean abstractions)
- `src/repositories/*.ts` — drizzle implementations
- `src/services/*.ts` — services already depend on repo interfaces, not drizzle classes

---

## Task 1: Create StorageBackend interface

**Files:**

- Create: `src/backend/types.ts`

- [ ] **Step 1: Create the backend types file**

```typescript
// src/backend/types.ts
import type {
  MemoryRepository,
  WorkspaceRepository,
  CommentRepository,
  SessionTrackingRepository,
  SessionRepository,
  AuditRepository,
  FlagRepository,
  RelationshipRepository,
  SchedulerStateRepository,
} from "../repositories/types.js";

export type BackendName = "postgres" | "vault";

/**
 * Storage backend abstraction. Bundles the eight repository interfaces
 * plus a lifecycle hook. `server.ts` constructs one of these via
 * `createBackend()` and passes the individual repos to services.
 *
 * New backends (e.g. vault) implement this interface without touching
 * service or tool code.
 */
export interface StorageBackend {
  readonly name: BackendName;
  readonly memoryRepo: MemoryRepository;
  readonly workspaceRepo: WorkspaceRepository;
  readonly commentRepo: CommentRepository;
  readonly sessionRepo: SessionTrackingRepository;
  readonly sessionLifecycleRepo: SessionRepository;
  readonly auditRepo: AuditRepository;
  readonly flagRepo: FlagRepository;
  readonly relationshipRepo: RelationshipRepository;
  readonly schedulerStateRepo: SchedulerStateRepository;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no references yet — file exists but nothing imports it).

- [ ] **Step 3: Commit**

```bash
git add src/backend/types.ts
git commit -m "feat(backend): introduce StorageBackend interface"
```

---

## Task 2: Create PostgresBackend implementation

**Files:**

- Create: `src/backend/postgres/index.ts`

- [ ] **Step 1: Create the PostgresBackend class**

```typescript
// src/backend/postgres/index.ts
import { createDb, type Database } from "../../db/index.js";
import { runMigrations } from "../../db/migrate.js";
import { DrizzleMemoryRepository } from "../../repositories/memory-repository.js";
import { DrizzleWorkspaceRepository } from "../../repositories/workspace-repository.js";
import { DrizzleCommentRepository } from "../../repositories/comment-repository.js";
import {
  DrizzleSessionTrackingRepository,
  DrizzleSessionRepository,
} from "../../repositories/session-repository.js";
import { DrizzleAuditRepository } from "../../repositories/audit-repository.js";
import { DrizzleFlagRepository } from "../../repositories/flag-repository.js";
import { DrizzleRelationshipRepository } from "../../repositories/relationship-repository.js";
import { DrizzleSchedulerStateRepository } from "../../repositories/scheduler-state-repository.js";
import type { StorageBackend, BackendName } from "../types.js";
import type {
  MemoryRepository,
  WorkspaceRepository,
  CommentRepository,
  SessionTrackingRepository,
  SessionRepository,
  AuditRepository,
  FlagRepository,
  RelationshipRepository,
  SchedulerStateRepository,
} from "../../repositories/types.js";

/**
 * Postgres + pgvector backend. Holds the drizzle Database handle and the
 * eight Drizzle* repository instances. `close()` ends the postgres-js
 * connection pool.
 *
 * Construct via `PostgresBackend.create(databaseUrl)` — it runs migrations
 * before returning, matching the prior inline behavior in `server.ts`.
 */
export class PostgresBackend implements StorageBackend {
  readonly name: BackendName = "postgres";
  readonly memoryRepo: MemoryRepository;
  readonly workspaceRepo: WorkspaceRepository;
  readonly commentRepo: CommentRepository;
  readonly sessionRepo: SessionTrackingRepository;
  readonly sessionLifecycleRepo: SessionRepository;
  readonly auditRepo: AuditRepository;
  readonly flagRepo: FlagRepository;
  readonly relationshipRepo: RelationshipRepository;
  readonly schedulerStateRepo: SchedulerStateRepository;

  private constructor(readonly db: Database) {
    this.memoryRepo = new DrizzleMemoryRepository(db);
    this.workspaceRepo = new DrizzleWorkspaceRepository(db);
    this.commentRepo = new DrizzleCommentRepository(db);
    this.sessionRepo = new DrizzleSessionTrackingRepository(db);
    this.sessionLifecycleRepo = new DrizzleSessionRepository(db);
    this.auditRepo = new DrizzleAuditRepository(db);
    this.flagRepo = new DrizzleFlagRepository(db);
    this.relationshipRepo = new DrizzleRelationshipRepository(db);
    this.schedulerStateRepo = new DrizzleSchedulerStateRepository(db);
  }

  static async create(databaseUrl: string): Promise<PostgresBackend> {
    const db = createDb(databaseUrl);
    await runMigrations(db);
    return new PostgresBackend(db);
  }

  async close(): Promise<void> {
    await this.db.$client.end();
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/backend/postgres/index.ts
git commit -m "feat(backend): add PostgresBackend wrapping existing drizzle repos"
```

---

## Task 3: Add `backend` field to config

**Files:**

- Modify: `src/config.ts`

- [ ] **Step 1: Add the backend field to the zod schema**

Edit `src/config.ts`. Insert the new field after `projectId` and before `databaseUrl` (roughly lines 5-6 area) and add the env-var mapping in the `configSchema.parse({...})` call.

Change in schema (insert new field):

```typescript
const configSchema = z.object({
  projectId: z.string().default(""),
  backend: z.enum(["postgres", "vault"]).default("postgres"),
  databaseUrl: z
    .string()
    .default("postgresql://agentic:agentic@localhost:5432/agent_brain"),
  // ... (unchanged fields below)
```

Change in the `parse({...})` call (insert new mapping):

```typescript
export const config = configSchema.parse({
  projectId: process.env.PROJECT_ID ?? "",
  backend: process.env.AGENT_BRAIN_BACKEND,
  databaseUrl: process.env.DATABASE_URL,
  // ... (unchanged fields below)
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run unit tests**

Run: `npm run test:unit`
Expected: PASS — 143 tests, unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add AGENT_BRAIN_BACKEND selector"
```

---

## Task 4: Create backend factory — TDD

**Files:**

- Create: `src/backend/factory.ts`
- Create: `tests/unit/backend/factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backend/factory.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createBackend } from "../../../src/backend/factory.js";

describe("createBackend", () => {
  it("throws when given the vault backend name (not yet implemented)", async () => {
    await expect(
      createBackend({ backend: "vault", databaseUrl: "postgresql://unused" }),
    ).rejects.toThrow(/vault backend is not yet implemented/i);
  });

  it("throws when given an unknown backend name", async () => {
    await expect(
      createBackend({
        // @ts-expect-error — intentionally exercising a runtime-only bad value
        backend: "nosuch",
        databaseUrl: "postgresql://unused",
      }),
    ).rejects.toThrow(/unknown backend/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit -- tests/unit/backend/factory.test.ts`
Expected: FAIL with "Cannot find module" (factory.ts doesn't exist yet).

- [ ] **Step 3: Create the factory**

Create `src/backend/factory.ts`:

```typescript
// src/backend/factory.ts
import type { BackendName, StorageBackend } from "./types.js";
import { PostgresBackend } from "./postgres/index.js";

export interface BackendConfig {
  backend: BackendName;
  databaseUrl: string;
}

/**
 * Select and construct the configured storage backend.
 *
 * Phase 0 only ships the postgres backend. The vault backend is
 * declared in the type enum so downstream code can already switch on
 * it, but `createBackend({ backend: "vault" })` throws until Phase 1+
 * lands the implementation.
 */
export async function createBackend(
  config: BackendConfig,
): Promise<StorageBackend> {
  switch (config.backend) {
    case "postgres":
      return PostgresBackend.create(config.databaseUrl);
    case "vault":
      throw new Error(
        "vault backend is not yet implemented — set AGENT_BRAIN_BACKEND=postgres",
      );
    default: {
      // Exhaustiveness + runtime guard for an env-var typo that slipped past zod.
      const _exhaustive: never = config.backend;
      throw new Error(`unknown backend: ${String(_exhaustive)}`);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify the "vault" case passes**

Run: `npm run test:unit -- tests/unit/backend/factory.test.ts`
Expected: The "vault" test passes. The "unknown backend" test may still fail because zod rejects `"nosuch"` before reaching the factory — but this test bypasses zod entirely (direct call to `createBackend`) so it should reach the `default` branch and pass.

If both pass: proceed. If not: inspect the failure; fix factory to match expected error messages. Do not change the test's expected regexes.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/factory.ts tests/unit/backend/factory.test.ts
git commit -m "feat(backend): add createBackend factory with vault stub"
```

---

## Task 5: Refactor server.ts to use the factory

**Files:**

- Modify: `src/server.ts`

This task re-wires the existing server code. Behavior MUST NOT change; all integration tests run against pg and must stay green.

- [ ] **Step 1: Replace repo + db construction with the factory**

In `src/server.ts`, delete the existing imports for individual Drizzle repos and `createDb` / `runMigrations`. Replace with factory import.

Remove these lines (around lines 7-20):

```typescript
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
// ... and all Drizzle*Repository imports
```

Add:

```typescript
import { createBackend } from "./backend/factory.js";
import { PostgresBackend } from "./backend/postgres/index.js";
```

- [ ] **Step 2: Replace the inline db+migration+repos block with `createBackend()`**

Replace the block from roughly line 46 (`// Initialize database`) through line 95 (last `const relationshipRepo = ...`) with:

```typescript
// Initialize storage backend (runs migrations for postgres)
let backend;
try {
  backend = await createBackend({
    backend: config.backend,
    databaseUrl: config.databaseUrl,
  });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err != null && typeof err === "object" && "code" in err
      ? (err as { code: string }).code
      : "";
  const isConnectionError =
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code.startsWith("08"); // PostgreSQL connection exception class
  if (isConnectionError) {
    logger.error(
      `Database connection failed: ${msg}. Is PostgreSQL running? Try: docker compose up -d`,
    );
  } else {
    logger.error(`Backend initialization failed: ${msg}`);
  }
  throw err;
}
logger.info(`Backend ready: ${backend.name}`);

// Initialize embedding provider
const embedder = createEmbeddingProvider();
logger.info(
  `Embedding provider: ${embedder.modelName} (${embedder.dimensions}d)`,
);

// Validate project ID
if (!config.projectId) {
  logger.error("PROJECT_ID environment variable is required");
  process.exit(1);
}
logger.info(`Project: ${config.projectId}`);

// Destructure repositories from the backend
const {
  memoryRepo,
  workspaceRepo,
  commentRepo,
  sessionRepo,
  sessionLifecycleRepo,
  auditRepo,
  flagRepo,
  relationshipRepo,
} = backend;
```

- [ ] **Step 3: Update the scheduler-wiring block to use the backend**

Around the `if (config.consolidationEnabled) {` block (roughly line 132), replace the body. The scheduler currently uses `db` directly for advisory locks — that's pg-specific, so we only wire it when the backend is actually `PostgresBackend`.

Replace:

```typescript
if (config.consolidationEnabled) {
  const schedulerStateRepo = new DrizzleSchedulerStateRepository(db);
  const consolidationJob = new ConsolidationJob(
    consolidationService,
    db,
    schedulerStateRepo,
  );
  // ...
}
```

With:

```typescript
if (config.consolidationEnabled) {
  if (!(backend instanceof PostgresBackend)) {
    logger.warn(
      `Consolidation scheduler requires postgres backend; current backend is '${backend.name}'. Scheduler disabled.`,
    );
  } else {
    const consolidationJob = new ConsolidationJob(
      consolidationService,
      backend.db,
      backend.schedulerStateRepo,
    );
    consolidationScheduler = new ConsolidationScheduler(
      consolidationJob,
      config.consolidationCron,
      backend.schedulerStateRepo,
      {
        enabled: config.consolidationCatchupEnabled,
        graceSeconds: config.consolidationCatchupGraceSeconds,
      },
    );
    await consolidationScheduler.start();
  }
}
```

- [ ] **Step 4: Replace the shutdown hook with backend.close()**

Replace:

```typescript
const shutdown = async () => {
  logger.info("Shutting down...");
  if (consolidationScheduler) {
    await consolidationScheduler.stop();
  }
  await db.$client.end();
  process.exit(0);
};
```

With:

```typescript
const shutdown = async () => {
  logger.info("Shutting down...");
  if (consolidationScheduler) {
    await consolidationScheduler.stop();
  }
  await backend.close();
  process.exit(0);
};
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Fix any dangling references to the removed `db` local (only inside the scheduler block and shutdown hook should have used it — both now use `backend.db` / `backend.close()`).

- [ ] **Step 6: Run the server-boot smoke test**

Run: `npm run test:unit -- tests/unit/server-boot.test.ts`
Expected: PASS. This test spawns `node --import tsx` and imports `src/server.ts` under the real Node ESM loader (no boot, just graph resolution). Catches the most common regression source in this file (CJS/ESM interop).

- [ ] **Step 7: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS — 143 tests + 2 new factory tests = 145.

- [ ] **Step 8: Run integration tests (requires docker pg)**

Run: `docker compose up -d db && npm run test:integration`
Expected: PASS. All existing integration tests use a live postgres; the refactor must preserve their behavior byte-for-byte.

- [ ] **Step 9: Boot the server locally to smoke-test**

Run: `AGENT_BRAIN_BACKEND=postgres npm run dev`
Expected: log line `Backend ready: postgres`, followed by `Server ready on http://127.0.0.1:19898/mcp`. Ctrl-C to stop.

- [ ] **Step 10: Verify the vault path fails cleanly**

Run: `AGENT_BRAIN_BACKEND=vault npm run dev`
Expected: Fatal error with message `vault backend is not yet implemented — set AGENT_BRAIN_BACKEND=postgres`. Process exits non-zero.

- [ ] **Step 11: Commit**

```bash
git add src/server.ts
git commit -m "refactor(server): wire storage via createBackend factory"
```

---

## Task 6: Document the new env var

**Files:**

- Modify: `.env.example`

- [ ] **Step 1: Add AGENT_BRAIN_BACKEND to .env.example**

Edit `.env.example`. Insert immediately above the existing `DATABASE_URL` line:

```
# Storage backend: postgres (default) | vault (planned, not yet implemented)
AGENT_BRAIN_BACKEND=postgres

```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document AGENT_BRAIN_BACKEND selector"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm run test:unit`
Expected: 145 tests pass.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Format**

Run: `npm run format`
Expected: no diff (if any, commit as chore).

- [ ] **Step 5: Review the diff**

Run: `git diff main...HEAD --stat`
Expected: only these paths changed:

```
.env.example
docs/superpowers/plans/2026-04-21-vault-backend-phase-0-abstraction.md
docs/superpowers/specs/2026-04-21-vault-backend-design.md
src/backend/factory.ts
src/backend/postgres/index.ts
src/backend/types.ts
src/config.ts
src/server.ts
tests/unit/backend/factory.test.ts
```

Any other modified file = regression. Investigate before proceeding.

---

## Notes for the next phase

- Phase 1 (parser) adds `src/backend/vault/parser/*` — pure functions. No wiring into the factory yet.
- Phase 2 (vault repos without git/vector) adds `src/backend/vault/repositories/*` + replaces the factory's `"vault"` branch with an actual `VaultBackend.create(...)` call. Factory tests switch from "throws" to "returns backend".
- The `PostgresBackend instanceof` check in `server.ts` is intentional and survives Phase 1-3. Only when vault-appropriate scheduling (Phase 4+) is designed does that branch change.
