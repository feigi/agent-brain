# memory_create: Project-scope confirmation flow

**Issue:** [#21](https://github.com/feigi/agent-brain/issues/21)
**Date:** 2026-04-20
**Status:** Approved (pending implementation)

## Problem

`memory_create` with `scope: "project"` + autonomous `source` (`agent-auto` or `session-review`) hard-rejects with a `VALIDATION_ERROR`. Agents hit a dead end: there is no structured path forward, so they silently downgrade to `workspace` scope. The guardrail is correct in principle (project scope = cross-workspace; user must confirm), but the failure mode defeats its purpose by pushing agents toward the wrong recovery.

A second, lower-severity friction: passing `workspace_id` alongside `scope: "project"` also hard-rejects. Combined, an agent can hit two sequential validation failures for a single logically-correct intent.

## Goals

1. Provide agents a structured retry path that preserves `source` provenance (no forced downgrade to `source: "manual"`).
2. Remove the second-blocker friction by silently coercing `workspace_id` to `null` on project scope.
3. Leave an audit trail recording that a user approved cross-workspace creation.
4. Consistent with existing agent-retry patterns in the codebase (budget/dedup skip envelope).

## Non-goals

- Expanding autonomous-source detection beyond `agent-auto` and `session-review` (custom sources continue to bypass the guard; preexisting behavior, out of scope).
- Changes to global CLAUDE.md or host-side agent instruction wording.
- New error classes or HTTP status codes.

## Design

### Retry signaling — `CreateSkipResult` envelope, not an error

Follow the established pattern used for budget/dedup (`src/services/memory-service.ts:128-139`). Agent-retry signals return a structured skip envelope at HTTP 200; they do not throw.

Extend the discriminated union in `src/types/memory.ts`:

```ts
export interface CreateSkipResult {
  skipped: true;
  reason:
    | "budget_exceeded"
    | "duplicate"
    | "requires_project_scope_confirmation"; // new
  message: string;
  duplicate?: {
    id: string;
    title: string;
    relevance: number;
    scope?: MemoryScope;
  };
}
```

Agent reads `reason`, prompts the user to confirm, and retries with a confirmation flag set.

### Confirmation flag — `user_confirmed_project_scope`

Add to `MemoryCreate` input type (`src/types/memory.ts`):

```ts
export interface MemoryCreate {
  // ... existing fields ...
  user_confirmed_project_scope?: boolean;
}
```

Add to tool input schema (`src/tools/memory-create.ts`):

```ts
user_confirmed_project_scope: z
  .boolean()
  .optional()
  .describe(
    "Set true after the user has explicitly confirmed cross-workspace (project) scope. Required alongside scope:'project' when source is 'agent-auto' or 'session-review'.",
  ),
```

Name is deliberately specific so agents do not reuse it for unrelated confirmations.

### Service logic — `MemoryService.create`

Replace the two current guards in `src/services/memory-service.ts:94-113`:

1. **Drop the `workspace_id`-on-project rejection (lines 97-101).** When `effectiveScope === "project"`, force `effectiveWorkspaceId = null` regardless of input. Silent coercion. Rationale: `scope=project` is unambiguous; rejecting the redundant `workspace_id` created a second blocker without safety value.

2. **Replace the autonomous-project hard-reject (lines 109-113) with a skip envelope:**

   ```ts
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

3. **Thread `user_confirmed_project_scope` through `MemoryCreate` and into the audit call** (see next section).

### Audit trail

Extend `AuditService.logCreate(id, actor, reason?)` in `src/services/audit-service.ts`:

```ts
async logCreate(memoryId: string, actor: string, reason?: string): Promise<void> {
  await this.log(memoryId, "created", actor, reason);
}
```

When a confirmed project-scope memory is created, the caller in `memory-service.ts:237` passes `reason: "user-confirmed project scope"`. Audit history (`getHistory`) can then surface _who_ approved the cross-workspace write and _when_.

No schema change — `audit` table already has a `reason` column used by archive/flag events.

### Tool description + guidance prompt

**`src/tools/memory-create.ts`** — update the `scope` description to point agents at the new flag:

> `'workspace' scopes to this workspace (shared with team), 'user' is private to you, 'project' is visible across all workspaces (set user_confirmed_project_scope:true after asking the user)`.

**`src/prompts/memory-guidance.ts`** — replace the "Cannot be created autonomously" wording with:

> `project`: Visible to all users across ALL workspaces. Use for universal project knowledge (coding standards, architecture principles). When calling autonomously (source `agent-auto` or `session-review`), you must first ask the user to confirm, then retry with `user_confirmed_project_scope: true`.

## Examples

### Agent autonomous attempt — before confirmation

Call:

```ts
memory_create({
  user_id: "chris",
  scope: "project",
  type: "learning",
  source: "session-review",
  title: "Dependabot auto-merge gotcha",
  content: "...",
});
```

Response (HTTP 200):

```json
{
  "data": {
    "skipped": true,
    "reason": "requires_project_scope_confirmation",
    "message": "Project-scoped memory requires user confirmation. Ask the user to confirm this memory should be visible across all workspaces, then retry with user_confirmed_project_scope: true."
  },
  "meta": { "timing": 3 }
}
```

### Agent retry after user confirms

Call:

```ts
memory_create({
  user_id: "chris",
  scope: "project",
  type: "learning",
  source: "session-review",
  title: "Dependabot auto-merge gotcha",
  content: "...",
  user_confirmed_project_scope: true,
});
```

Response: normal successful `Memory` envelope. Audit history shows:

```
action: "created"  actor: "chris"  reason: "user-confirmed project scope"
```

### Manual write — unchanged

`source: "manual"` bypasses the guard entirely (not autonomous). `user_confirmed_project_scope` is ignored; no audit reason recorded.

### `workspace_id` passed with `scope: "project"`

Silently coerced to `null` server-side. No error. Created memory has `workspace_id = null`.

## Testing

### Unit (`tests/unit/`)

New test file or additions to existing create-flow tests:

- Autonomous source (`agent-auto` and `session-review`) + `scope: "project"` + no flag → returns `CreateSkipResult` with `reason: "requires_project_scope_confirmation"`. Does NOT throw.
- Autonomous source + `scope: "project"` + `user_confirmed_project_scope: true` → success. Audit entry has `reason: "user-confirmed project scope"`.
- `source: "manual"` + `scope: "project"` (no flag) → success. Audit entry has no reason.
- `scope: "project"` + `workspace_id: "foo"` passed → success, resulting memory has `workspace_id: null` (replaces the prior throw test).
- Non-project scopes unaffected by the new flag (flag ignored; behavior identical to today).

### Integration (`tests/integration/memory-scoping.test.ts`)

- End-to-end MCP tool call: autonomous → skip envelope; retry with flag → success; audit row present with the confirmation reason.

## Rollout

No migration needed. Changes are:

- Backwards-compatible for existing callers passing `source: "manual"` or non-project scope (behavior identical).
- For callers relying on the old `VALIDATION_ERROR` throw on autonomous project scope: they now receive a skip envelope instead. Agents in the wild handle `CreateSkipResult` already (budget/dedup paths), so disruption is minimal.
- Error-message consumers parsing the exact rejection string lose that signal — acceptable since the remediation path is now structured.

## Implementation order

1. Extend `CreateSkipResult` union + `MemoryCreate` type.
2. Update `MemoryService.create`: drop workspace_id guard, replace throw with skip envelope, thread flag + audit reason.
3. Extend `AuditService.logCreate` signature.
4. Update tool schema + description.
5. Update `memory-guidance` prompt.
6. Tests (unit then integration).
