# Slim Memory Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce token waste by returning only useful fields from list endpoints, while keeping full details available via `memory_get`.

**Architecture:** Add `MemorySummary` and `MemoryDetail` projection types alongside the existing `Memory` interface. Projection functions (`toSummary`, `toDetail`) map `Memory` objects at the service layer before wrapping in `Envelope`. Repository layer unchanged.

**Tech Stack:** TypeScript, Vitest

---

### File Structure

| File                                       | Action | Responsibility                                                                                              |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------- |
| `src/types/memory.ts`                      | Modify | Add `MemorySummary`, `MemoryDetail`, derived types, `toSummary()`, `toDetail()`                             |
| `src/services/memory-service.ts`           | Modify | Apply projections in `search`, `sessionStart`, `list`, `listRecentActivity`, `listStale`, `getWithComments` |
| `tests/integration/memory-scoping.test.ts` | Modify | Fix assertion that references `project_id` on search result                                                 |

---

### Task 1: Add projection types and functions

**Files:**

- Modify: `src/types/memory.ts`

- [ ] **Step 1: Write the `MemorySummary` interface**

Add after the existing `Memory` interface (after line 38):

```typescript
// Slim projection for list endpoints — omits internal/DB-only fields
export interface MemorySummary {
  id: string;
  title: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  tags: string[] | null;
  author: string;
  source: string | null;
  created_at: Date;
  updated_at: Date;
  verified_at: Date | null;
  verified_by: string | null;
  comment_count: number;
  last_comment_at: Date | null;
}
```

- [ ] **Step 2: Write the `MemoryDetail` interface**

Add after `MemorySummary`:

```typescript
// Full projection for detail endpoints — everything except embedding internals
export interface MemoryDetail extends MemorySummary {
  project_id: string;
  workspace_id: string | null;
  version: number;
  session_id: string | null;
  metadata: Record<string, unknown> | null;
  archived_at: Date | null;
}
```

- [ ] **Step 3: Write `toSummary` projection function**

Add after the interfaces:

```typescript
/** Project a full Memory to the slim list representation */
export function toSummary(memory: Memory): MemorySummary {
  return {
    id: memory.id,
    title: memory.title,
    content: memory.content,
    type: memory.type,
    scope: memory.scope,
    tags: memory.tags,
    author: memory.author,
    source: memory.source,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    verified_at: memory.verified_at,
    verified_by: memory.verified_by,
    comment_count: memory.comment_count,
    last_comment_at: memory.last_comment_at,
  };
}
```

- [ ] **Step 4: Write `toDetail` projection function**

```typescript
/** Project a full Memory to the detail representation (strips embedding internals) */
export function toDetail(memory: Memory): MemoryDetail {
  return {
    ...toSummary(memory),
    project_id: memory.project_id,
    workspace_id: memory.workspace_id,
    version: memory.version,
    session_id: memory.session_id,
    metadata: memory.metadata,
    archived_at: memory.archived_at,
  };
}
```

- [ ] **Step 5: Add derived types and update existing ones**

Replace the existing `MemoryWithRelevance` (line 87-89) and `MemoryWithChangeType` (line 59-61):

```typescript
// Slim variants for list endpoints
export interface MemorySummaryWithRelevance extends MemorySummary {
  relevance: number;
}

export interface MemorySummaryWithChangeType extends MemorySummary {
  change_type: "created" | "updated" | "commented";
}
```

Keep the old `MemoryWithRelevance` and `MemoryWithChangeType` — they extend `Memory` and are still used internally by the repository layer and for intermediate computation. Rename them to clarify:

Actually, no — the repository returns `MemoryWithRelevance` from `search()`. The service receives these, then projects. So keep the old types as-is for internal use. Just add the new `MemorySummary*` variants for the service return types.

- [ ] **Step 6: Update `MemoryGetResponse` to extend `MemoryDetail`**

Replace the existing `MemoryGetResponse` (line 50-56):

```typescript
// D-72, D-63: Enhanced response for memory_get with comments and capability flags
export interface MemoryGetResponse extends MemoryDetail {
  comments: Comment[];
  can_comment: boolean;
  can_edit: boolean;
  can_archive: boolean;
  can_verify: boolean;
}
```

- [ ] **Step 7: Run type check to verify**

Run: `npx tsc --noEmit`
Expected: PASS (no consumers of the changed `MemoryGetResponse` type should break since `MemoryDetail` has all the same fields as the old `Memory` base minus embedding fields, and nothing accesses embedding fields on `MemoryGetResponse`)

- [ ] **Step 8: Commit**

```bash
git add src/types/memory.ts
git commit -m "feat: add MemorySummary and MemoryDetail projection types"
```

---

### Task 2: Apply projections in service layer

**Files:**

- Modify: `src/services/memory-service.ts`

- [ ] **Step 1: Update imports**

Update the import from `../types/memory.js` to include the new types and functions:

```typescript
import type {
  Memory,
  MemoryCreate,
  MemoryUpdate,
  MemoryWithRelevance,
  Comment,
  MemoryGetResponse,
  MemoryWithChangeType,
  CreateSkipResult,
  MemorySummary,
  MemorySummaryWithRelevance,
  MemorySummaryWithChangeType,
} from "../types/memory.js";
import { toSummary, toDetail } from "../types/memory.js";
```

Note: split the value imports (`toSummary`, `toDetail`) into a separate non-`type` import since they're runtime functions.

- [ ] **Step 2: Update `search()` return type and projection**

Change the return type from `Promise<Envelope<MemoryWithRelevance[]>>` to `Promise<Envelope<MemorySummaryWithRelevance[]>>`.

In the method body, after the `scored.sort(...)` and `const results = scored.slice(0, effectiveLimit);` lines (~line 602), project the results before returning:

```typescript
const projected: MemorySummaryWithRelevance[] = results.map((r) => ({
  ...toSummary(r),
  relevance: r.relevance,
}));

const timing = Date.now() - start;
return {
  data: projected,
  meta: { count: projected.length, timing },
};
```

- [ ] **Step 3: Update `sessionStart()` return type and projection**

Change the return type from `Promise<Envelope<MemoryWithRelevance[]>>` to `Promise<Envelope<MemorySummaryWithRelevance[]>>`.

Update the local `result` variable type (~line 647):

```typescript
let result: Envelope<MemorySummaryWithRelevance[]>;
```

The `context` branch calls `this.search()` which now returns projected data — no change needed.

The no-context branch builds `MemoryWithRelevance[]` from `recentMemories`. Update the mapping (~line 670):

```typescript
const scored: MemorySummaryWithRelevance[] = recentMemories.map((memory) => ({
  ...toSummary(memory),
  relevance: computeRelevance(
    1.0,
    memory.created_at,
    memory.verified_at,
    config.recencyHalfLifeDays,
  ),
}));
```

- [ ] **Step 4: Update `list()` return type and projection**

Change the return type from `Promise<Envelope<Memory[]>>` to `Promise<Envelope<MemorySummary[]>>`.

Project after fetching (~line 780):

```typescript
const projected = result.memories.map(toSummary);

const timing = Date.now() - start;
return {
  data: projected,
  meta: {
    count: projected.length,
    has_more: result.has_more,
    cursor: result.cursor
      ? `${result.cursor.created_at}|${result.cursor.id}`
      : undefined,
    timing,
  },
};
```

- [ ] **Step 5: Update `listRecentActivity()` return type and projection**

Change the return type from `Promise<Envelope<MemoryWithChangeType[]>>` to `Promise<Envelope<MemorySummaryWithChangeType[]>>`.

Update the mapping (~line 411):

```typescript
const withChangeType: MemorySummaryWithChangeType[] = recentMemories.map(
  (memory) => ({
    ...toSummary(memory),
    change_type: this.getChangeType(memory, since),
  }),
);
```

- [ ] **Step 6: Update `listStale()` return type and projection**

Change the return type from `Promise<Envelope<Memory[]>>` to `Promise<Envelope<MemorySummary[]>>`.

After the `filtered` line (~line 840), project:

```typescript
const projected = filtered.map(toSummary);

const timing = Date.now() - start;
return {
  data: projected,
  meta: {
    count: projected.length,
    has_more: result.has_more,
    cursor: result.cursor
      ? `${result.cursor.created_at}|${result.cursor.id}`
      : undefined,
    timing,
  },
};
```

- [ ] **Step 7: Update `getWithComments()` to use `toDetail`**

In the return statement (~line 308), replace `...memory` spread with `...toDetail(memory)`:

```typescript
return {
  data: {
    ...toDetail(memory),
    comments: commentsList,
    ...capabilities,
  },
  meta: { timing },
};
```

- [ ] **Step 8: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS — or compile errors pointing to test files that reference stripped fields (addressed in Task 3).

- [ ] **Step 9: Commit**

```bash
git add src/services/memory-service.ts
git commit -m "feat: apply slim projections in all list and detail endpoints"
```

---

### Task 3: Fix test that references stripped field

**Files:**

- Modify: `tests/integration/memory-scoping.test.ts:41-44`

- [ ] **Step 1: Update the cross-project search assertion**

The test at line 41-44 currently asserts:

```typescript
const crossProjectMatch = result.data.find((m) => m.project_id === "project-a");
expect(crossProjectMatch).toBeUndefined();
```

`project_id` is no longer on search results. The test's intent is to verify workspace isolation — that searching in `project-b` doesn't return memories from `project-a`. The result set being empty already proves this. Replace with:

```typescript
// Workspace isolation: searching in project-b should not return project-a's memories
const crossWorkspaceMatch = result.data.find(
  (m) => m.content === "Secret project-a knowledge about deployment pipelines",
);
expect(crossWorkspaceMatch).toBeUndefined();
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/memory-scoping.test.ts
git commit -m "test: update scoping test to not reference stripped project_id field"
```

---

### Task 4: Verify end-to-end

- [ ] **Step 1: Run full test suite and type check in parallel**

Run: `npx tsc --noEmit && npm test`
Expected: All pass, no type errors.

- [ ] **Step 2: Manual smoke test via REST API**

Start the server and call session_start to verify the response shape:

```bash
curl -s -X POST http://localhost:19898/api/tools/memory_session_start \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"agent-brain","user_id":"chris","limit":2}' | jq '.data[0] | keys'
```

Expected keys: `author`, `comment_count`, `content`, `created_at`, `id`, `last_comment_at`, `relevance`, `scope`, `source`, `tags`, `title`, `type`, `updated_at`, `verified_at`, `verified_by`.

Should NOT contain: `project_id`, `workspace_id`, `embedding_model`, `embedding_dimensions`, `version`, `session_id`, `metadata`, `archived_at`.

- [ ] **Step 3: Commit all (if any fixups needed)**

Only if previous tasks needed fixups. Otherwise this step is a no-op.
