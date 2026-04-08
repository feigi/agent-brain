# Relationship Tracking: PR Review Fixes

**Date:** 2026-04-08
**Status:** Approved
**PR:** feigi/agent-brain#14 (feature/relationship-tracking)

## Overview

Implement all fixes identified by the 5-agent comprehensive review of PR #14. Covers security, correctness, data integrity, error handling, type improvements, and test coverage gaps.

## Section 1: Security & Correctness

### 1a. Access control on `listForMemory` anchor memory

`RelationshipService.listForMemory` must validate that the requesting user can access the queried memory before returning any relationships. Add `findById` + `canAccess` check at the top, throwing `NotFoundError` if inaccessible. Matches the `getWithComments` pattern.

**File:** `src/services/relationship-service.ts`, `listForMemory` method

### 1b. NaN-safe `validateConfidence`

Change `if (confidence < 0 || confidence > 1)` to `if (!(confidence >= 0 && confidence <= 1))`. This rejects `NaN`, `Infinity`, and `-Infinity` — all of which pass the current check. The Zod layer catches these for MCP tools, but `createInternal` bypasses Zod.

**File:** `src/services/relationship-service.ts`, `validateConfidence` method

### 1c. `remove` allows creator or target-side when source is archived

When the source memory is archived (or deleted), `findById` returns `null` and `canEditSource` is false. For non-consolidation relationships this makes them permanently unremovable. Fix: also allow removal when `relationship.created_by === userId`, or when the source is gone and the user can access the target.

**File:** `src/services/relationship-service.ts`, `remove` method

## Section 2: Data Integrity & Error Handling

### 2a-2c. Extract `tryCreateRelationship` helper

Extract a private method in `ConsolidationService`:

```typescript
private async tryCreateRelationship(input: CreateRelationshipInput): Promise<string | undefined> {
  if (!this.relationshipService) return undefined;
  try {
    const rel = await this.relationshipService.createInternal(input);
    return rel.id;
  } catch (error) {
    logger.error(`Failed to create ${input.type} relationship ${input.sourceId} → ${input.targetId}:`, error);
    return undefined;
  }
}
```

This single helper addresses three issues:

- **Deduplication:** Collapses 6 near-identical try/catch blocks into single-line calls
- **`relationship_id: undefined` guard:** The helper returns `undefined` on failure; callers use `...(relId ? { relationship_id: relId } : {})` in flag details
- **Log level:** Uses `logger.error` instead of `logger.warn` for failed DB writes

Similarly upgrade the `archiveByMemoryId` catch blocks in `memory-service.ts` (archive loop) from `logger.warn` to `logger.error`. Read-path catches (`memory_get`, `session_start`) stay as `logger.warn`.

**Files:** `src/services/consolidation-service.ts`, `src/services/memory-service.ts`

## Section 3: Consolidation Direction Consistency

Normalize source/target to: **source = dominant/surviving memory, target = superseded/archived memory.**

Currently subset detection uses the opposite direction (source=archived, target=surviving). Fix by flipping:

```
// Before:
sourceId: active[i].id  // archived/smaller
targetId: active[j].id  // surviving/larger

// After:
sourceId: active[j].id  // surviving/larger
targetId: active[i].id  // archived/smaller
```

Update the migration script comment to document the now-consistent convention.

**Files:** `src/services/consolidation-service.ts`, `scripts/migrate-flag-relationships.ts`

## Section 4: Type & API Improvements

### 4a. Export `RelationshipType`

Add `export` to the type alias in `src/types/relationship.ts`.

### 4b. Move `CreateRelationshipInput` to types directory

Move the interface from `relationship-service.ts` to `src/types/relationship.ts`. Import it back in the service. Consistent with `MemoryCreate`/`MemoryUpdate` placement.

### 4c. Document `related_memory` semantics

Add JSDoc to `RelationshipWithMemory.related_memory`:

```typescript
/** In listForMemory: the memory on the opposite end from the queried one.
 *  In listBetweenMemories: always the target memory (source->target canonical direction). */
related_memory: RelatedMemorySummary;
```

### 4d. Fix README inaccuracy

Change "All tools require `workspace_id` and `user_id`" to note that relationship tools only require `user_id` — they operate at the project level.

### 4e. Tool description improvements

- `memory_relate`: add "Idempotent: if an identical relationship (same source, target, and type) already exists, returns the existing one."
- `memory_unrelate`: clarify "Remove (soft-delete) a relationship by relationship ID."

**Files:** `src/types/relationship.ts`, `src/services/relationship-service.ts`, `src/tools/memory-relate.ts`, `src/tools/memory-unrelate.ts`, `README.md`

## Section 5: Test Coverage

All tests in `tests/integration/relationship-service.test.ts` unless noted.

### 5a. Direct `createInternal` tests

New describe block:

- Creates relationships across user-scoped memories without access checks
- Rejects self-referencing (`sourceId === targetId`)
- Rejects memories from a different project
- Deduplicates (returns existing on match)
- Rejects non-existent memory IDs

### 5b. Fix consolidation test assertions

**File:** `tests/integration/consolidation.test.ts`

Remove `if (rels.length > 0)` conditional assertions. Either test `createInternal` directly with deterministic inputs, or assert unconditionally.

### 5c. `listBetweenMemories` access control test

Create a relationship between a workspace memory and a user-scoped memory belonging to user A. Call `listBetweenMemories` as user B. Verify the relationship is excluded.

### 5d. Confidence boundary tests

Service-layer tests:

- `confidence: -0.1` throws `ValidationError`
- `confidence: 1.1` throws `ValidationError`
- `confidence: NaN` throws `ValidationError`
- `confidence: 0` succeeds
- `confidence: 1` succeeds

### 5e. `remove` with archived source memory

Create a relationship, archive the source memory, attempt removal by the creator. Verify it succeeds (validates fix 1c).

### 5f. `listForMemory` access control on anchor memory

Call `listForMemory` with another user's user-scoped memory ID. Verify `NotFoundError` is thrown (validates fix 1a).

## Out of Scope

- `warnings` meta field in response envelope (broader API change, separate feature)
- `findByIds` project_id filtering (implicit via relationship scoping, acceptable)
