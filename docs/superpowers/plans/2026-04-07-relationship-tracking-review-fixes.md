# Relationship Tracking Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 17 findings from the 5-agent PR review of the `feature/relationship-tracking` branch before merge.

**Architecture:** All changes are on the `feature/relationship-tracking` branch. Fixes span the service layer (access control, validation, error handling), types (exports, relocation), consolidation (direction consistency, helper extraction), tool descriptions, README, and test coverage.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM, Zod

**Branch:** `feature/relationship-tracking` (all work happens here)

---

### Task 1: Access control on `listForMemory` anchor memory

**Files:**

- Modify: `src/services/relationship-service.ts` (`listForMemory` method)
- Modify: `tests/integration/relationship-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `listForMemory access control` describe block in `tests/integration/relationship-service.test.ts`:

```typescript
it("throws NotFoundError when querying another user's user-scoped memory", async () => {
  const memService = createTestService();

  // Create Bob's user-scoped memory
  const bobResult = await memService.create({
    workspace_id: "test-ws",
    content: "bob's private memory",
    type: "fact",
    author: "bob",
    scope: "user",
  });
  assertMemory(bobResult.data);

  // Alice tries to list relationships for Bob's private memory
  await expect(
    service.listForMemory(bobResult.data.id, "both", "alice"),
  ).rejects.toThrow(NotFoundError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --grep "throws NotFoundError when querying another user"`
Expected: FAIL — currently returns empty array instead of throwing

- [ ] **Step 3: Write minimal implementation**

In `src/services/relationship-service.ts`, add access control check at the start of `listForMemory`:

```typescript
async listForMemory(
  memoryId: string,
  direction: "outgoing" | "incoming" | "both",
  userId: string,
  type?: string,
): Promise<RelationshipWithMemory[]> {
  // Validate the requesting user can access the anchor memory
  const anchorMemory = await this.memoryRepo.findById(memoryId);
  if (
    !anchorMemory ||
    anchorMemory.project_id !== this.projectId ||
    !this.canAccess(anchorMemory, userId)
  ) {
    throw new NotFoundError("Memory", memoryId);
  }

  const relationships = await this.relationshipRepo.findByMemoryId(
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --grep "throws NotFoundError when querying another user"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/relationship-service.ts tests/integration/relationship-service.test.ts
git commit -m "fix: add access control check on listForMemory anchor memory"
```

---

### Task 2: NaN-safe `validateConfidence`

**Files:**

- Modify: `src/services/relationship-service.ts` (`validateConfidence` method)
- Modify: `tests/integration/relationship-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block in `tests/integration/relationship-service.test.ts`:

```typescript
describe("confidence validation", () => {
  it("rejects NaN confidence", async () => {
    await expect(
      service.create({
        sourceId,
        targetId,
        type: "overrides",
        confidence: NaN,
        userId: "alice",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects negative confidence", async () => {
    await expect(
      service.create({
        sourceId,
        targetId,
        type: "overrides",
        confidence: -0.1,
        userId: "alice",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects confidence above 1", async () => {
    await expect(
      service.create({
        sourceId,
        targetId,
        type: "overrides",
        confidence: 1.1,
        userId: "alice",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("accepts confidence of 0", async () => {
    const rel = await service.create({
      sourceId,
      targetId,
      type: "overrides",
      confidence: 0,
      userId: "alice",
    });
    expect(rel.confidence).toBe(0);
  });

  it("accepts confidence of 1", async () => {
    const rel = await service.create({
      sourceId,
      targetId,
      type: "overrides",
      confidence: 1,
      userId: "alice",
    });
    expect(rel.confidence).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify NaN test fails**

Run: `npm test -- --grep "rejects NaN confidence"`
Expected: FAIL — NaN passes the current check

- [ ] **Step 3: Fix `validateConfidence`**

In `src/services/relationship-service.ts`, change:

```typescript
private validateConfidence(confidence: number): void {
  if (!(confidence >= 0 && confidence <= 1)) {
    throw new ValidationError(
      `Confidence must be between 0 and 1, got ${confidence}`,
    );
  }
}
```

- [ ] **Step 4: Run all confidence tests**

Run: `npm test -- --grep "confidence validation"`
Expected: All 5 PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/relationship-service.ts tests/integration/relationship-service.test.ts
git commit -m "fix: reject NaN/Infinity in validateConfidence"
```

---

### Task 3: Fix `remove` when source memory is archived

**Files:**

- Modify: `src/services/relationship-service.ts` (`remove` method)
- Modify: `tests/integration/relationship-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `remove` describe block:

```typescript
it("allows creator to remove relationship when source memory is archived", async () => {
  const memService = createTestService();

  // Alice creates two workspace memories
  const s = await memService.create({
    workspace_id: "test-ws",
    content: "source that will be archived",
    type: "fact",
    author: "alice",
  });
  assertMemory(s.data);
  const t = await memService.create({
    workspace_id: "test-ws",
    content: "target memory",
    type: "fact",
    author: "alice",
  });
  assertMemory(t.data);

  // Alice creates a relationship
  const rel = await service.create({
    sourceId: s.data.id,
    targetId: t.data.id,
    type: "overrides",
    userId: "alice",
  });

  // Archive the source memory
  await memService.archive([s.data.id], "alice");

  // Alice (creator) should still be able to remove the relationship
  await expect(service.remove(rel.id, "alice")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --grep "allows creator to remove relationship when source memory is archived"`
Expected: FAIL — throws NotFoundError because source is archived

- [ ] **Step 3: Fix `remove` method**

In `src/services/relationship-service.ts`, update the `remove` method:

```typescript
async remove(id: string, userId: string): Promise<void> {
  const relationship = await this.relationshipRepo.findById(id);
  if (!relationship) {
    throw new NotFoundError("Relationship", id);
  }

  const source = await this.memoryRepo.findById(relationship.source_id);
  const target = await this.memoryRepo.findById(relationship.target_id);

  const isCreator = relationship.created_by === userId;
  const canEditSource = source && this.canAccess(source, userId);
  const canEditTarget = target && this.canAccess(target, userId);
  const canEditEitherSide =
    relationship.created_via === "consolidation" &&
    (canEditSource || canEditTarget);
  // Allow removal if: user can access source, OR user created it,
  // OR (source is gone and user can access target),
  // OR (consolidation-created and user can access either side)
  const canRemove =
    canEditSource ||
    isCreator ||
    (!source && canEditTarget) ||
    canEditEitherSide;

  if (!canRemove) {
    throw new NotFoundError("Relationship", id);
  }

  await this.relationshipRepo.archiveById(id);
  logger.debug(`Archived relationship ${id}`);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --grep "remove"`
Expected: All remove tests PASS (including the existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/services/relationship-service.ts tests/integration/relationship-service.test.ts
git commit -m "fix: allow relationship removal when source memory is archived"
```

---

### Task 4: Extract `tryCreateRelationship` helper + fix log levels and undefined guard

**Files:**

- Modify: `src/services/consolidation-service.ts`
- Modify: `src/services/memory-service.ts`

- [ ] **Step 1: Add `tryCreateRelationship` helper to `ConsolidationService`**

In `src/services/consolidation-service.ts`, add the import for `CreateRelationshipInput` and the private method:

```typescript
import type { CreateRelationshipInput } from "./relationship-service.js";
```

Add below the constructor:

```typescript
private async tryCreateRelationship(
  input: CreateRelationshipInput,
): Promise<string | undefined> {
  if (!this.relationshipService) return undefined;
  try {
    const rel = await this.relationshipService.createInternal(input);
    return rel.id;
  } catch (error) {
    logger.error(
      `Failed to create ${input.type} relationship ${input.sourceId} → ${input.targetId}:`,
      error,
    );
    return undefined;
  }
}
```

- [ ] **Step 2: Replace all 6 inline try/catch blocks with helper calls**

Replace each `if (this.relationshipService) { try { ... } catch { ... } }` block in `consolidateScope`, `crossScopeCheck`, and `userScopeCheck` with a single call.

**Content subset (in `consolidateScope`):**

Replace the relationship archiving + creation block with:

```typescript
if (this.relationshipService) {
  try {
    await this.relationshipService.archiveByMemoryId(active[i].id);
  } catch (error) {
    logger.error(
      `Failed to archive relationships for auto-archived memory ${active[i].id}:`,
      error,
    );
  }
}
const subsetRelationshipId = await this.tryCreateRelationship({
  sourceId: active[j].id,
  targetId: active[i].id,
  type: "duplicates",
  confidence: 1.0,
  userId: "consolidation",
  createdVia: "consolidation",
});
```

Note: `sourceId` is now `active[j].id` (surviving) and `targetId` is `active[i].id` (archived) — this fixes the direction inconsistency (Task 5 overlap).

**Near-exact duplicate auto-archive (in `consolidateScope`):**

Replace the archive + create blocks with:

```typescript
if (this.relationshipService) {
  try {
    await this.relationshipService.archiveByMemoryId(olderMemoryId);
  } catch (error) {
    logger.error(
      `Failed to archive relationships for auto-archived memory ${olderMemoryId}:`,
      error,
    );
  }
}
const autoArchiveRelationshipId = await this.tryCreateRelationship({
  sourceId: pair.memory_a_id,
  targetId: olderMemoryId,
  type: "duplicates",
  confidence: pair.similarity,
  userId: "consolidation",
  createdVia: "consolidation",
});
```

**Flagged duplicate (in `consolidateScope`):**

```typescript
const flagDupRelationshipId = await this.tryCreateRelationship({
  sourceId: pair.memory_a_id,
  targetId: pair.memory_b_id,
  type: "duplicates",
  confidence: pair.similarity,
  userId: "consolidation",
  createdVia: "consolidation",
});
```

**Cross-scope (in `crossScopeCheck`):**

```typescript
const crossScopeRelationshipId = await this.tryCreateRelationship({
  sourceId: dup.id,
  targetId: wsMem.id,
  type: "overrides",
  confidence: dup.relevance,
  userId: "consolidation",
  createdVia: "consolidation",
});
```

**User-scope (in `userScopeCheck`):**

```typescript
const userScopeRelationshipId = await this.tryCreateRelationship({
  sourceId: dup.id,
  targetId: userMem.id,
  type: "overrides",
  confidence: dup.relevance,
  userId: "consolidation",
  createdVia: "consolidation",
});
```

- [ ] **Step 3: Guard `relationship_id` in all flag details**

In all 5 `createFlag` calls that include `relationship_id`, change from:

```typescript
relationship_id: someRelationshipId,
```

to:

```typescript
...(someRelationshipId ? { relationship_id: someRelationshipId } : {}),
```

This applies to the subset, auto-archive, flagged-duplicate, cross-scope, and user-scope flag creation calls.

- [ ] **Step 4: Fix `logger.warn` → `logger.error` in `memory-service.ts` archive loop**

In `src/services/memory-service.ts`, change the archive relationship loop (around line 598):

```typescript
logger.error(`Failed to archive relationships for memory ${id}:`, error);
```

Keep the `memory_get` and `session_start` relationship catch blocks as `logger.warn` — those are read-path best-effort.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/consolidation-service.ts src/services/memory-service.ts
git commit -m "refactor: extract tryCreateRelationship helper, fix log levels and undefined guard"
```

---

### Task 5: Fix consolidation source/target direction + migration script comment

**Files:**

- Modify: `src/services/consolidation-service.ts` (already done in Task 4 — verify)
- Modify: `scripts/migrate-flag-relationships.ts`

- [ ] **Step 1: Verify direction fix from Task 4**

The subset detection direction was already fixed in Task 4 Step 2 (first replacement). Verify that the `tryCreateRelationship` call for content subset uses:

- `sourceId: active[j].id` (surviving/larger)
- `targetId: active[i].id` (archived/smaller)

- [ ] **Step 2: Update migration script comment**

In `scripts/migrate-flag-relationships.ts`, replace lines 14-16:

```typescript
/**
 * ...
 * Source/target convention (consistent across all consolidation cases):
 *   - source_id = relatedMemoryId (the surviving/dominant memory)
 *   - target_id = flag.memory_id   (the flagged/superseded memory)
 */
```

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-flag-relationships.ts
git commit -m "docs: update migration script comment for consistent source/target convention"
```

---

### Task 6: Type improvements — export, relocate, document

**Files:**

- Modify: `src/types/relationship.ts`
- Modify: `src/services/relationship-service.ts`
- Modify: `src/services/consolidation-service.ts`

- [ ] **Step 1: Export `RelationshipType` and move `CreateRelationshipInput`**

In `src/types/relationship.ts`, add `export` to the type alias and add the `CreateRelationshipInput` interface:

```typescript
export type RelationshipType = WellKnownRelationshipType | (string & {});
```

Add `CreateRelationshipInput` after the `Relationship` interface:

```typescript
export interface CreateRelationshipInput {
  sourceId: string;
  targetId: string;
  type: string;
  description?: string;
  /** Value between 0 and 1 inclusive */
  confidence?: number;
  userId: string;
  createdVia?: string;
}
```

Add JSDoc to `related_memory` in `RelationshipWithMemory`:

```typescript
/** In listForMemory: the memory on the opposite end from the queried one.
 *  In listBetweenMemories: always the target memory (source→target canonical direction). */
related_memory: RelatedMemorySummary;
```

- [ ] **Step 2: Update imports in `relationship-service.ts`**

Remove the `CreateRelationshipInput` interface definition from `src/services/relationship-service.ts`. Update the import:

```typescript
import type {
  Relationship,
  RelationshipWithMemory,
  CreateRelationshipInput,
} from "../types/relationship.js";
```

- [ ] **Step 3: Update import in `consolidation-service.ts`**

Change the import from:

```typescript
import type { CreateRelationshipInput } from "./relationship-service.js";
```

to:

```typescript
import type { CreateRelationshipInput } from "../types/relationship.js";
```

- [ ] **Step 4: Run tests to verify no regressions**

Run: `npm test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/relationship.ts src/services/relationship-service.ts src/services/consolidation-service.ts
git commit -m "refactor: export RelationshipType, move CreateRelationshipInput to types"
```

---

### Task 7: Tool descriptions and README fixes

**Files:**

- Modify: `src/tools/memory-relate.ts`
- Modify: `src/tools/memory-unrelate.ts`
- Modify: `README.md`

- [ ] **Step 1: Update `memory_relate` description**

In `src/tools/memory-relate.ts`, change the description to:

```typescript
description: `Create a directional relationship between two memories. Idempotent: if an identical relationship (same source, target, and type) already exists, returns the existing one. Well-known types: ${wellKnownList}. Any descriptive string is also valid.`,
```

- [ ] **Step 2: Update `memory_unrelate` description**

In `src/tools/memory-unrelate.ts`, change:

```typescript
description:
  'Remove (soft-delete) a relationship by relationship ID. The relationship is archived and excluded from all queries. Example: memory_unrelate({ id: "abc123", user_id: "alice" })',
```

- [ ] **Step 3: Fix README**

In `README.md`, change line 303 from:

```
All tools require `workspace_id` and `user_id`. Workspaces are created automatically on first use.
```

to:

```
All tools require `user_id`. Most tools also require `workspace_id` (workspaces are created automatically on first use). The relationship tools (`memory_relate`, `memory_unrelate`, `memory_relationships`) are exceptions — they operate at the project level.
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/memory-relate.ts src/tools/memory-unrelate.ts README.md
git commit -m "docs: fix tool descriptions and README workspace_id claim"
```

---

### Task 8: `createInternal` direct tests

**Files:**

- Modify: `tests/integration/relationship-service.test.ts`

- [ ] **Step 1: Add `createInternal` describe block**

Add after the existing `create` describe block:

```typescript
describe("createInternal", () => {
  it("creates relationships across user-scoped memories without access checks", async () => {
    const memService = createTestService();

    // Create Alice's user-scoped memory
    const aliceResult = await memService.create({
      workspace_id: "test-ws",
      content: "alice's private memory",
      type: "fact",
      author: "alice",
      scope: "user",
    });
    assertMemory(aliceResult.data);

    // Create Bob's user-scoped memory
    const bobResult = await memService.create({
      workspace_id: "test-ws",
      content: "bob's private memory",
      type: "fact",
      author: "bob",
      scope: "user",
    });
    assertMemory(bobResult.data);

    // createInternal should succeed even though consolidation can't access either user-scoped memory
    const rel = await service.createInternal({
      sourceId: aliceResult.data.id,
      targetId: bobResult.data.id,
      type: "duplicates",
      userId: "consolidation",
      createdVia: "consolidation",
    });

    expect(rel.id).toBeDefined();
    expect(rel.source_id).toBe(aliceResult.data.id);
    expect(rel.target_id).toBe(bobResult.data.id);
  });

  it("rejects self-referencing", async () => {
    await expect(
      service.createInternal({
        sourceId,
        targetId: sourceId,
        type: "duplicates",
        userId: "consolidation",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects non-existent memory IDs", async () => {
    await expect(
      service.createInternal({
        sourceId: "non-existent-id",
        targetId,
        type: "duplicates",
        userId: "consolidation",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("deduplicates like create", async () => {
    const first = await service.createInternal({
      sourceId,
      targetId,
      type: "duplicates",
      userId: "consolidation",
    });
    const second = await service.createInternal({
      sourceId,
      targetId,
      type: "duplicates",
      userId: "consolidation",
    });
    expect(second.id).toBe(first.id);
  });

  it("rejects memories from a different project", async () => {
    // Create a service scoped to a different project
    const db = getTestDb();
    const relationshipRepo = new DrizzleRelationshipRepository(db);
    const memoryRepo = new DrizzleMemoryRepository(db);
    const otherProjectService = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "other-project",
    );

    // sourceId and targetId belong to "test-project"
    await expect(
      otherProjectService.createInternal({
        sourceId,
        targetId,
        type: "duplicates",
        userId: "consolidation",
      }),
    ).rejects.toThrow(NotFoundError);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- --grep "createInternal"`
Expected: All 5 PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/relationship-service.test.ts
git commit -m "test: add direct tests for createInternal"
```

---

### Task 9: Fix consolidation test assertions + add remaining test coverage

**Files:**

- Modify: `tests/integration/consolidation.test.ts`
- Modify: `tests/integration/relationship-service.test.ts`

- [ ] **Step 1: Fix conditional assertions in consolidation tests**

In `tests/integration/consolidation.test.ts`, in the "creates a duplicates relationship when flagging duplicates" test, replace the conditional assertion:

```typescript
// Old: if (rels.length > 0) { ... }
// New: test createInternal directly since mock embeddings can't reliably trigger thresholds
```

Replace the entire test body with a direct test that creates content-subset memories (which don't depend on embedding similarity):

```typescript
it("creates a duplicates relationship for content-subset auto-archive", async () => {
  // Create a short memory and a longer one that contains it
  const m1 = await service.create({
    workspace_id: "test-ws",
    content: "use snake_case for columns",
    type: "decision",
    author: "alice",
  });
  assertMemory(m1.data);
  const m2 = await service.create({
    workspace_id: "test-ws",
    content: "use snake_case for columns and always add timestamps",
    type: "decision",
    author: "alice",
  });
  assertMemory(m2.data);

  await consolidationService.run();

  // m1 is a content subset of m2, so a "duplicates" relationship should exist
  const rels = await relationshipRepo.findByMemoryId(
    "test-project",
    m1.data.id,
    "both",
  );
  expect(rels).toHaveLength(1);
  expect(rels[0].type).toBe("duplicates");
  expect(rels[0].created_via).toBe("consolidation");
  // After direction fix: source = surviving (m2), target = archived (m1)
  expect(rels[0].source_id).toBe(m2.data.id);
  expect(rels[0].target_id).toBe(m1.data.id);
});
```

For the "creates overrides relationship for cross-scope supersedence" test, add an assertion comment that mock embeddings can't trigger this reliably, and keep it as a smoke test:

```typescript
it("runs cross-scope check without errors (mock embeddings may not trigger threshold)", async () => {
  const proj = await service.create({
    workspace_id: "test-ws",
    content: "Global rule about API naming",
    type: "decision",
    scope: "project",
    author: "alice",
    source: "manual",
  });
  assertMemory(proj.data);
  const ws = await service.create({
    workspace_id: "test-ws",
    content: "Global rule about API naming conventions",
    type: "decision",
    author: "alice",
  });
  assertMemory(ws.data);

  const result = await consolidationService.run();
  expect(result.errors).toBe(0);
});
```

- [ ] **Step 2: Add `listBetweenMemories` access control test**

In `tests/integration/relationship-service.test.ts`, add to the `listBetweenMemories` describe block:

```typescript
it("excludes relationships where either side is inaccessible", async () => {
  const memService = createTestService();

  // Create a workspace memory
  const wsResult = await memService.create({
    workspace_id: "test-ws",
    content: "shared workspace memory",
    type: "fact",
    author: "alice",
    scope: "workspace",
  });
  assertMemory(wsResult.data);

  // Create Bob's user-scoped memory
  const bobResult = await memService.create({
    workspace_id: "test-ws",
    content: "bob's private memory",
    type: "fact",
    author: "bob",
    scope: "user",
  });
  assertMemory(bobResult.data);

  // Bob creates a relationship
  await service.create({
    sourceId: wsResult.data.id,
    targetId: bobResult.data.id,
    type: "refines",
    userId: "bob",
  });

  // Alice calls listBetweenMemories — Bob's memory is inaccessible
  const results = await service.listBetweenMemories(
    [wsResult.data.id, bobResult.data.id],
    "alice",
  );
  expect(results).toHaveLength(0);
});
```

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add tests/integration/consolidation.test.ts tests/integration/relationship-service.test.ts
git commit -m "test: fix conditional assertions, add createInternal and access control tests"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All PASS, 0 failures

- [ ] **Step 2: Run linter**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Verify no regressions in existing tests**

Run: `npm test -- --reporter=verbose 2>&1 | tail -30`
Expected: All test suites pass
