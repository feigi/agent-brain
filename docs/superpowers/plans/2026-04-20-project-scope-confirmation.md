# Project-scope Confirmation Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-reject on autonomous project-scope `memory_create` with a structured skip envelope + `user_confirmed_project_scope` flag, and silently coerce `workspace_id` to `null` when `scope=project`.

**Architecture:** Extend `CreateSkipResult` discriminated union with a new `requires_project_scope_confirmation` reason (matches budget/dedup pattern). Add `user_confirmed_project_scope?: boolean` to `MemoryCreate` + tool/HTTP schemas. In `MemoryService.create`, drop the `workspace_id`-on-project guard (silent coerce) and convert the autonomous-source guard from `throw` → return skip envelope. Record approvals via `AuditService.logCreate(id, actor, reason?)`.

**Tech Stack:** TypeScript, Zod, Drizzle ORM, Vitest, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-04-20-project-scope-confirmation-design.md`

---

## File Structure

**Modify:**

- `src/types/memory.ts` — extend `MemoryCreate` + `CreateSkipResult`
- `src/services/audit-service.ts` — extend `logCreate` signature
- `src/services/memory-service.ts` — drop workspace_id throw; replace autonomous throw with skip envelope; thread flag + audit reason
- `src/tools/memory-create.ts` — add param to tool schema, wire through
- `src/routes/api-schemas.ts` — add param to HTTP tool schema
- `src/routes/api-tools.ts` — thread param
- `src/prompts/memory-guidance.ts` — update guidance wording
- `tests/integration/memory-scoping.test.ts` — replace prior throw test; add e2e confirmation flow tests

**Create:**

- `tests/unit/project-scope-confirmation.test.ts` — focused unit suite for new guard behavior

---

## Task 1: Extend types

**Files:**

- Modify: `src/types/memory.ts:168-207`

- [ ] **Step 1: Extend `MemoryCreate` with confirmation flag**

Edit `src/types/memory.ts` — within the `MemoryCreate` interface (lines 169-180), add the new field:

```ts
// Input type for creating a memory
export interface MemoryCreate {
  workspace_id?: string; // optional for project-scoped memories (cross-workspace)
  content: string;
  title?: string; // D-03: auto-generate from content if omitted
  type: MemoryType;
  scope?: MemoryScope; // defaults to "workspace"
  tags?: string[];
  author: string; // D-25, D-38: required for provenance
  source?: string; // D-23: manual, agent-auto, session-review, etc.
  session_id?: string; // D-24
  metadata?: Record<string, unknown>; // D-26
  user_confirmed_project_scope?: boolean; // Issue #21: unblocks autonomous project-scope creation after user approval
}
```

- [ ] **Step 2: Extend `CreateSkipResult.reason` union**

Edit `src/types/memory.ts:196-207`:

```ts
// Phase 4: Discriminated union result for autonomous memory_create (budget or dedup skip)
export interface CreateSkipResult {
  skipped: true;
  reason:
    | "budget_exceeded"
    | "duplicate"
    | "requires_project_scope_confirmation";
  message: string;
  duplicate?: {
    id: string;
    title: string;
    relevance: number;
    scope?: MemoryScope;
  };
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors (the fields are optional / additive).

- [ ] **Step 4: Commit**

```bash
git add src/types/memory.ts
git commit -m "feat(types): extend MemoryCreate + CreateSkipResult for project-scope confirmation (#21)"
```

---

## Task 2: Extend `AuditService.logCreate` to accept optional reason

**Files:**

- Modify: `src/services/audit-service.ts:36-38`
- Test: `tests/unit/project-scope-confirmation.test.ts` (new file in later task; this task verifies via typecheck + existing callers)

- [ ] **Step 1: Edit `logCreate` signature**

Edit `src/services/audit-service.ts:36-38`:

```ts
async logCreate(
  memoryId: string,
  actor: string,
  reason?: string,
): Promise<void> {
  await this.log(memoryId, "created", actor, reason);
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors. The parameter is optional; the existing call-site at `src/services/memory-service.ts:237` continues to compile.

- [ ] **Step 3: Run existing audit tests**

Run: `npx vitest run tests/integration/audit.test.ts`
Expected: all pass — no behavior change for existing callers.

- [ ] **Step 4: Commit**

```bash
git add src/services/audit-service.ts
git commit -m "feat(audit): accept optional reason on logCreate (#21)"
```

---

## Task 3: Add `user_confirmed_project_scope` to tool + HTTP schemas (no service changes yet)

Separating the schema-plumbing from the service logic keeps each commit focused and reviewable.

**Files:**

- Modify: `src/tools/memory-create.ts:22-61`
- Modify: `src/tools/memory-create.ts:63-79` (tool handler)
- Modify: `src/routes/api-schemas.ts:19-30`
- Modify: `src/routes/api-tools.ts:51-67`

- [ ] **Step 1: Update `scope` description + add new field in `src/tools/memory-create.ts`**

Replace lines 41-45 (the existing `scope` field):

```ts
        scope: memoryScopeEnum
          .catch("workspace")
          .describe(
            "'workspace' scopes to this workspace (shared with team), 'user' is private to you, 'project' is visible across all workspaces (set user_confirmed_project_scope:true after asking the user)",
          ),
```

Then add, immediately before `user_id: userIdSchema` (line 46):

```ts
        user_confirmed_project_scope: z
          .boolean()
          .optional()
          .describe(
            "Set true after the user has explicitly confirmed cross-workspace (project) scope. Required alongside scope:'project' when source is 'agent-auto' or 'session-review'.",
          ),
```

- [ ] **Step 2: Wire the new field through the tool handler**

Edit `src/tools/memory-create.ts:63-79`. Add the field inside the `memoryService.create({...})` call:

```ts
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.create({
          workspace_id: params.workspace_id,
          content: params.content,
          title: params.title,
          type: params.type,
          tags: params.tags,
          scope: params.scope,
          author: params.user_id,
          source: params.source,
          session_id: params.session_id,
          metadata: params.metadata,
          user_confirmed_project_scope: params.user_confirmed_project_scope,
        });
        return toolResponse(result);
      });
    },
```

- [ ] **Step 3: Add the field to the HTTP Zod schema**

Edit `src/routes/api-schemas.ts:19-30`. Append the new optional field:

```ts
  memory_create: z.object({
    workspace_id: slugSchema.optional(),
    content: contentSchema,
    title: z.string().optional(),
    type: memoryTypeEnum,
    tags: z.array(z.string()).optional(),
    scope: memoryScopeEnum.default("workspace"),
    user_id: slugSchema,
    source: z.string().optional(),
    session_id: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    user_confirmed_project_scope: z.boolean().optional(),
  }),
```

- [ ] **Step 4: Thread the field through the HTTP handler**

Edit `src/routes/api-tools.ts:51-67`. Add the new field inside the `memoryService.create({...})` call:

```ts
        case "memory_create": {
          const b = body as z.infer<typeof toolSchemas.memory_create>;
          const result = await memoryService.create({
            workspace_id: b.workspace_id,
            content: b.content,
            title: b.title,
            type: b.type,
            tags: b.tags,
            scope: b.scope,
            author: b.user_id,
            source: b.source,
            session_id: b.session_id,
            metadata: b.metadata,
            user_confirmed_project_scope: b.user_confirmed_project_scope,
          });
          res.json(result);
          break;
        }
```

- [ ] **Step 5: Verify typecheck + existing tests**

Run: `npm run typecheck && npx vitest run tests/unit/mcp-schemas.test.ts`
Expected: all pass. The service still ignores the field (no behavior change yet), so all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/memory-create.ts src/routes/api-schemas.ts src/routes/api-tools.ts
git commit -m "feat(api): add user_confirmed_project_scope to memory_create schema (#21)"
```

---

## Task 4: Unit test — silent workspace_id coercion on project scope

TDD: write the test first, confirm it fails, then change the service.

**Files:**

- Create: `tests/unit/project-scope-confirmation.test.ts`

- [ ] **Step 1: Create the new unit test file**

Create `tests/unit/project-scope-confirmation.test.ts` with the following skeleton plus the first test. This file will grow across Tasks 4-6.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryService } from "../../src/services/memory-service.js";
import { AuditService } from "../../src/services/audit-service.js";
import type { Memory } from "../../src/types/memory.js";
import type {
  MemoryRepository,
  WorkspaceRepository,
  AuditRepository,
} from "../../src/repositories/types.js";
import type { EmbeddingProvider } from "../../src/providers/embedding/types.js";

const MOCK_EMBEDDING = new Array(768).fill(0);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date();
  return {
    id: "mem-proj-001",
    project_id: "test-project",
    workspace_id: null,
    content: "Test memory content",
    title: "Test memory",
    type: "fact",
    scope: "project",
    tags: null,
    author: "alice",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: "mock",
    embedding_dimensions: 768,
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

function makeMemoryRepo(): MemoryRepository {
  return {
    create: vi.fn().mockImplementation(async (input) => makeMemory(input)),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    archive: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    list: vi.fn(),
    findStale: vi.fn(),
    listRecentWorkspaceAndUser: vi.fn().mockResolvedValue([]),
    verify: vi.fn(),
    findRecentActivity: vi.fn().mockResolvedValue([]),
    countTeamActivity: vi.fn().mockResolvedValue({
      new_memories: 0,
      updated_memories: 0,
      commented_memories: 0,
    }),
    findDuplicates: vi.fn().mockResolvedValue([]),
  } as MemoryRepository;
}

function makeWorkspaceRepo(): WorkspaceRepository {
  return {
    findOrCreate: vi
      .fn()
      .mockResolvedValue({ id: "test-project", created_at: new Date() }),
    findById: vi.fn().mockResolvedValue(null),
  };
}

function makeEmbedder(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(MOCK_EMBEDDING),
    modelName: "mock",
    dimensions: 768,
  };
}

function makeAuditRepo(): AuditRepository {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    findByMemoryId: vi.fn().mockResolvedValue([]),
  } as AuditRepository;
}

function makeService(
  opts: {
    memoryRepo?: MemoryRepository;
    auditRepo?: AuditRepository;
  } = {},
): {
  service: MemoryService;
  memoryRepo: MemoryRepository;
  auditRepo: AuditRepository;
} {
  const memoryRepo = opts.memoryRepo ?? makeMemoryRepo();
  const workspaceRepo = makeWorkspaceRepo();
  const embedder = makeEmbedder();
  const auditRepo = opts.auditRepo ?? makeAuditRepo();
  const auditService = new AuditService(auditRepo, "test-project");
  const service = new MemoryService(
    memoryRepo,
    workspaceRepo,
    embedder,
    "test-project",
    undefined,
    undefined,
    undefined,
    auditService,
  );
  return { service, memoryRepo, auditRepo };
}

describe("Project-scope confirmation (issue #21)", () => {
  describe("workspace_id silent coercion on project scope", () => {
    it("accepts workspace_id with scope=project and coerces it to null", async () => {
      const { service, memoryRepo } = makeService();

      const result = await service.create({
        workspace_id: "ignored-workspace",
        content: "Cross-workspace decision",
        type: "decision",
        scope: "project",
        author: "alice",
        source: "manual",
      });

      expect("skipped" in result.data).toBe(false);
      expect(memoryRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "project",
          workspace_id: null,
        }),
      );
    });
  });
});
```

- [ ] **Step 2: Run the test — it should FAIL**

Run: `npx vitest run tests/unit/project-scope-confirmation.test.ts`
Expected: FAIL. The current service throws `ValidationError("workspace_id must not be provided...")` at `src/services/memory-service.ts:97-101`.

- [ ] **Step 3: Remove the workspace_id-on-project guard in `MemoryService.create`**

Edit `src/services/memory-service.ts`. Delete lines 94-101 (the "Mirror guard 0a" block), keeping the `effectiveWorkspaceId` derivation. The block to remove:

```ts
// Mirror guard 0a: project scope is cross-workspace by design — reject
// workspace_id explicitly rather than silently coercing, so callers
// learn their input was inconsistent with the scope they chose.
if (effectiveScope === "project" && input.workspace_id) {
  throw new ValidationError(
    `workspace_id must not be provided for project-scoped memories (project scope is cross-workspace).`,
  );
}
```

The `effectiveWorkspaceId` line immediately after (now at lines 94-95 after deletion) already handles the coercion:

```ts
const effectiveWorkspaceId =
  effectiveScope === "project" ? null : input.workspace_id!;
```

- [ ] **Step 4: Run the test — it should PASS**

Run: `npx vitest run tests/unit/project-scope-confirmation.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite to catch regressions**

Run: `npx vitest run --config vitest.ci.config.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/project-scope-confirmation.test.ts src/services/memory-service.ts
git commit -m "feat(memory): silently coerce workspace_id to null on project scope (#21)"
```

---

## Task 5: Unit tests + service change — autonomous project-scope returns skip envelope

**Files:**

- Modify: `tests/unit/project-scope-confirmation.test.ts`
- Modify: `src/services/memory-service.ts`

- [ ] **Step 1: Add failing tests for the skip envelope**

Append the following `describe` block to `tests/unit/project-scope-confirmation.test.ts`, inside the outer `describe("Project-scope confirmation (issue #21)", …)`:

```ts
describe("autonomous project-scope guard", () => {
  it("session-review source without confirmation returns skip envelope (not throws)", async () => {
    const { service, memoryRepo } = makeService();

    const result = await service.create({
      content: "Cross-workspace architectural decision",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "session-review",
    });

    expect(memoryRepo.create).not.toHaveBeenCalled();
    expect("skipped" in result.data).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("requires_project_scope_confirmation");
      expect(result.data.message).toMatch(/user_confirmed_project_scope/);
    }
  });

  it("agent-auto source without confirmation returns skip envelope", async () => {
    const { service, memoryRepo } = makeService();

    const result = await service.create({
      content: "Cross-workspace learning",
      type: "learning",
      scope: "project",
      author: "alice",
      source: "agent-auto",
    });

    expect(memoryRepo.create).not.toHaveBeenCalled();
    expect("skipped" in result.data).toBe(true);
    if ("skipped" in result.data) {
      expect(result.data.reason).toBe("requires_project_scope_confirmation");
    }
  });

  it("manual source is unaffected by the guard (creates successfully)", async () => {
    const { service, memoryRepo } = makeService();

    const result = await service.create({
      content: "User-directed cross-workspace note",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });

    expect("skipped" in result.data).toBe(false);
    expect(memoryRepo.create).toHaveBeenCalled();
  });

  it("autonomous source with user_confirmed_project_scope: true creates successfully", async () => {
    const { service, memoryRepo } = makeService();

    const result = await service.create({
      content: "Confirmed cross-workspace decision",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "session-review",
      user_confirmed_project_scope: true,
    });

    expect("skipped" in result.data).toBe(false);
    expect(memoryRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "project", workspace_id: null }),
    );
  });

  it("non-project scope ignores the confirmation flag (no behavior change)", async () => {
    const { service, memoryRepo } = makeService();

    const result = await service.create({
      workspace_id: "test-project",
      content: "Workspace memory",
      type: "fact",
      scope: "workspace",
      author: "alice",
      source: "session-review",
      user_confirmed_project_scope: true, // flag set but irrelevant
    });

    expect("skipped" in result.data).toBe(false);
    expect(memoryRepo.create).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests — the first two should FAIL (throws instead of returning skip envelope)**

Run: `npx vitest run tests/unit/project-scope-confirmation.test.ts`
Expected: "session-review …" and "agent-auto …" tests FAIL because the service currently throws a `ValidationError`. The "manual" + "non-project scope" tests may PASS (manual and workspace bypass the guard).

- [ ] **Step 3: Replace the autonomous-guard throw with a skip envelope**

Edit `src/services/memory-service.ts`. Find the block:

```ts
// Guard 0b -- Project-scope restriction: cannot be created by autonomous sources
const isAutonomous =
  input.source === "agent-auto" || input.source === "session-review";

if (effectiveScope === "project" && isAutonomous) {
  throw new ValidationError(
    `Project-scoped memories require user confirmation and cannot be created autonomously (source: '${input.source}').`,
  );
}
```

Replace it with:

```ts
// Guard 0b -- Project-scope restriction: autonomous sources need user confirmation.
// Return a structured skip envelope (matches budget/dedup pattern) so the agent
// can prompt the user and retry with user_confirmed_project_scope: true.
const isAutonomous =
  input.source === "agent-auto" || input.source === "session-review";

if (
  effectiveScope === "project" &&
  isAutonomous &&
  !input.user_confirmed_project_scope
) {
  return {
    data: {
      skipped: true,
      reason: "requires_project_scope_confirmation" as const,
      message:
        "Project-scoped memory requires user confirmation. Ask the user to confirm this memory should be visible across all workspaces, then retry with user_confirmed_project_scope: true.",
    },
    meta: { timing: Date.now() - start },
  };
}
```

The `const isAutonomous` declaration stays in its original position — it is re-used later by the budget guard and the post-insert increment. The only structural change is the `if` body: `throw` becomes `return skip envelope`, gated by the new `!input.user_confirmed_project_scope` condition.

- [ ] **Step 4: Run the tests — they should all PASS**

Run: `npx vitest run tests/unit/project-scope-confirmation.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the full unit + integration suite**

Run: `npm run typecheck && npx vitest run --config vitest.ci.config.ts`
Expected: all pass. If any existing unit/integration test asserted the old throw on autonomous project-scope, convert it to assert the skip envelope (or delete if redundant with the new tests).

- [ ] **Step 6: Commit**

```bash
git add tests/unit/project-scope-confirmation.test.ts src/services/memory-service.ts
git commit -m "feat(memory): return skip envelope for autonomous project-scope (#21)"
```

---

## Task 6: Record confirmation in the audit trail

**Files:**

- Modify: `tests/unit/project-scope-confirmation.test.ts`
- Modify: `src/services/memory-service.ts:237`

- [ ] **Step 1: Add failing test for audit reason**

Append to `tests/unit/project-scope-confirmation.test.ts`, inside the outer `describe`:

```ts
describe("audit trail on confirmed project-scope creation", () => {
  it("records user-confirmed project scope reason", async () => {
    const auditRepo = makeAuditRepo();
    const { service } = makeService({ auditRepo });

    await service.create({
      content: "Confirmed cross-workspace decision",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "session-review",
      user_confirmed_project_scope: true,
    });

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        actor: "alice",
        reason: "user-confirmed project scope",
      }),
    );
  });

  it("does NOT record reason for manual project-scope creation", async () => {
    const auditRepo = makeAuditRepo();
    const { service } = makeService({ auditRepo });

    await service.create({
      content: "Manual cross-workspace note",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        actor: "alice",
        reason: null,
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test — "records user-confirmed project scope reason" should FAIL**

Run: `npx vitest run tests/unit/project-scope-confirmation.test.ts`
Expected: FAIL — `logCreate` is currently called without a reason, so the audit record has `reason: null` for both cases.

- [ ] **Step 3: Pass the reason into `logCreate` when the flag is set**

Edit `src/services/memory-service.ts:237`. Replace:

```ts
await this.auditService?.logCreate(memory.id, input.author);
```

with:

```ts
const auditReason =
  effectiveScope === "project" && input.user_confirmed_project_scope
    ? "user-confirmed project scope"
    : undefined;
await this.auditService?.logCreate(memory.id, input.author, auditReason);
```

- [ ] **Step 4: Run the tests — they should all PASS**

Run: `npx vitest run tests/unit/project-scope-confirmation.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npx vitest run --config vitest.ci.config.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/project-scope-confirmation.test.ts src/services/memory-service.ts
git commit -m "feat(audit): record user-confirmed project scope reason (#21)"
```

---

## Task 7: Update agent-facing guidance text

**Files:**

- Modify: `src/prompts/memory-guidance.ts:33`

- [ ] **Step 1: Replace the existing "project" bullet in guidance**

Edit `src/prompts/memory-guidance.ts`. Locate the bullet at line 33:

```ts
- **project**: Visible to all users across ALL workspaces. Use for universal project knowledge (coding standards, architecture principles). Cannot be created autonomously -- requires user confirmation (source must not be 'agent-auto' or 'session-review').
```

Replace with:

```ts
- **project**: Visible to all users across ALL workspaces. Use for universal project knowledge (coding standards, architecture principles). Autonomous saves (source \`agent-auto\` or \`session-review\`) must first ask the user to confirm cross-workspace scope, then retry with \`user_confirmed_project_scope: true\`. Manual saves (source \`manual\`) bypass this guard.
```

(Preserve the existing escaping style. The bullet lives inside a template literal so backticks require `\``.)

- [ ] **Step 2: Run the prompt integration test**

Run: `npx vitest run tests/integration/prompt-resource.test.ts`
Expected: all pass. If the test asserts on specific text that changed, update the assertion alongside the guidance.

- [ ] **Step 3: Commit**

```bash
git add src/prompts/memory-guidance.ts tests/integration/prompt-resource.test.ts
git commit -m "docs(guidance): describe new project-scope confirmation flow (#21)"
```

(If the prompt test required no update, drop the test file from the `git add` list.)

---

## Task 8: Integration test — end-to-end confirmation flow

**Files:**

- Modify: `tests/integration/memory-scoping.test.ts`

- [ ] **Step 1: Remove any integration test asserting the old throw**

Search `tests/integration/memory-scoping.test.ts` for tests asserting:

- `ValidationError` on `scope: "project"` + `source: "session-review"` or `source: "agent-auto"`
- `"workspace_id must not be provided"`

Delete those tests (they contradict the new behavior). Grep to be sure:

```bash
grep -nE "Project-scoped memories|workspace_id must not" tests/integration/memory-scoping.test.ts
```

- [ ] **Step 2: Add the new integration tests using `createTestServiceWithAudit`**

The audit accessor lives on `AuditRepository.findByMemoryId(memoryId)` — see the existing pattern in `tests/integration/audit.test.ts`. Use `createTestServiceWithAudit(auditService)` from `tests/helpers.ts` so the service and audit repository share the same DB connection.

Append to `tests/integration/memory-scoping.test.ts`. You will need to import the helpers at the top of the file (next to the existing imports):

```ts
import { createTestServiceWithAudit } from "../helpers.js";
import { DrizzleAuditRepository } from "../../src/repositories/audit-repository.js";
import { AuditService } from "../../src/services/audit-service.js";
```

Then add, inside the `describe("Memory scoping integration tests", …)`:

```ts
describe("project-scope confirmation (#21)", () => {
  let serviceWithAudit: MemoryService;
  let auditRepo: DrizzleAuditRepository;

  beforeEach(() => {
    const db = getTestDb();
    auditRepo = new DrizzleAuditRepository(db);
    const auditService = new AuditService(auditRepo, "test-project");
    serviceWithAudit = createTestServiceWithAudit(auditService);
  });

  it("autonomous project-scope returns skip envelope; retry with confirmation succeeds", async () => {
    const skipResult = await serviceWithAudit.create({
      content: "Cross-workspace coding convention: prefer async/await",
      type: "pattern",
      scope: "project",
      author: "alice",
      source: "session-review",
    });

    expect("skipped" in skipResult.data).toBe(true);
    if ("skipped" in skipResult.data) {
      expect(skipResult.data.reason).toBe(
        "requires_project_scope_confirmation",
      );
    }

    // Retry after user confirms
    const okResult = await serviceWithAudit.create({
      content: "Cross-workspace coding convention: prefer async/await",
      type: "pattern",
      scope: "project",
      author: "alice",
      source: "session-review",
      user_confirmed_project_scope: true,
    });

    expect("skipped" in okResult.data).toBe(false);
    if (!("skipped" in okResult.data)) {
      expect(okResult.data.scope).toBe("project");
      expect(okResult.data.workspace_id).toBeNull();

      const entries = await auditRepo.findByMemoryId(okResult.data.id);
      const created = entries.find((e) => e.action === "created");
      expect(created?.reason).toBe("user-confirmed project scope");
    }
  });

  it("workspace_id with scope=project is silently coerced to null", async () => {
    const result = await serviceWithAudit.create({
      workspace_id: "should-be-ignored",
      content: "Universal rule applied to all workspaces",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });

    expect("skipped" in result.data).toBe(false);
    if (!("skipped" in result.data)) {
      expect(result.data.scope).toBe("project");
      expect(result.data.workspace_id).toBeNull();
    }
  });
});
```

Note the `beforeEach` re-uses `truncateAll()` from the outer block (which runs first).

- [ ] **Step 3: Run the integration tests**

Run: `npx vitest run tests/integration/memory-scoping.test.ts`
Expected: all pass.

- [ ] **Step 4: Run the entire test suite end-to-end**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/memory-scoping.test.ts
git commit -m "test(integration): e2e project-scope confirmation flow (#21)"
```

---

## Task 9: Final verification

- [ ] **Step 1: Format + lint + typecheck + tests**

Run: `npm run format && npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 2: Manual sanity check — grep for stale references**

Run:

```bash
grep -rn "workspace_id must not be provided" src/ tests/
grep -rn "Project-scoped memories require user confirmation" src/ tests/
grep -rn "Cannot be created autonomously" src/
```

Expected: no matches in `src/`. Any match in `tests/` should be inside a test that has already been deleted/updated in Tasks 4-8; fix if any slipped through.

- [ ] **Step 3: Verify the diff vs main is coherent**

Run: `git diff main --stat`
Expected: only the files listed in "File Structure" section above.

- [ ] **Step 4: Push + open PR** (only if the user confirms)

```bash
git push -u origin feat/project-scope-confirmation
gh pr create --title "memory_create: project-scope confirmation flow (#21)" --body "$(cat <<'EOF'
## Summary

- Replace hard-reject on autonomous project-scope `memory_create` with structured skip envelope (matches budget/dedup pattern)
- Add `user_confirmed_project_scope` flag for retry path
- Silently coerce `workspace_id` to null when `scope=project`
- Record approvals in audit trail via `AuditService.logCreate(id, actor, reason?)`

Closes #21. Spec: `docs/superpowers/specs/2026-04-20-project-scope-confirmation-design.md`.

## Test plan

- [ ] `npm test` passes
- [ ] Autonomous `session-review` + `scope: project` without flag → skip envelope (HTTP 200), no throw
- [ ] Retry with `user_confirmed_project_scope: true` creates memory, audit reason recorded
- [ ] `source: manual` + `scope: project` works as before (flag ignored)
- [ ] `workspace_id` passed with `scope: project` → silently coerced to null

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
