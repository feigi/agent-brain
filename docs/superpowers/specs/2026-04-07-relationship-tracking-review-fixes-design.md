# Relationship Tracking — PR Review Fixes

**Date:** 2026-04-07
**Status:** Approved
**Applies to:** `feature/relationship-tracking` branch (single fix-up commit before merge)

## Context

Five specialized review agents analyzed the `feature/relationship-tracking` PR (11 commits, 29 files, ~3K lines). This spec addresses all findings: 4 critical, 5 important, and 8 suggestions.

## 1. Database & Schema Changes

### Partial unique index

Replace the unconditional unique index with a partial one so soft-deleted relationships don't block re-creation of the same edge:

```sql
DROP INDEX "relationships_unique_edge";
CREATE UNIQUE INDEX "relationships_unique_edge"
  ON "relationships" ("project_id", "source_id", "target_id", "type")
  WHERE "archived_at" IS NULL;
```

### Rename `source` → `created_via`

New migration renaming the column. Update Drizzle schema, all TypeScript types (`Relationship`, `RelationshipWithMemory`, `CreateRelationshipInput`), repository, service, tools, migration script, and tests.

### `memory_unrelate` switches to soft-delete

`RelationshipRepository.deleteById()` becomes `archiveById()` — sets `archived_at` instead of `DELETE FROM`. The service's `remove()` calls the new method. Consistent with the spec's cascade philosophy: "No hard deletes — preserves history for audit and consolidation."

## 2. Service Layer Fixes

### `RelationshipService.createInternal()`

New method that skips `canAccess()` checks on source/target memories. Still validates both memories exist and belong to the project, still deduplicates. `create()` remains unchanged for MCP/REST callers.

Add a comment explaining the privilege model: consolidation is a system actor reachable via the `memory_consolidate` MCP tool, which already operates without per-user access control. `createInternal()` extends this existing pattern to relationship creation.

### Consolidation service — switch to `createInternal()`

All 5 `relationshipService.create()` call sites switch to `createInternal()`. The empty `catch { /* best-effort */ }` blocks get `logger.warn()` with context (memory IDs, relationship type, error).

### Consolidation auto-archive cascade

After `this.memoryRepo.archive()` in the auto-archive paths, call `relationshipService.archiveByMemoryId()` so relationships are soft-deleted immediately rather than left dangling.

### Unprotected queries in `memory-service.ts`

Wrap the three relationship loading sites in try-catch that degrades to empty arrays with `logger.warn`:

- `getWithComments` — relationship enrichment
- `sessionStart` / search — `listBetweenMemories` call
- `archive` — `archiveByMemoryId` loop (per-ID try-catch so one failure doesn't abort the rest)

### Batch loading — `findByIds`

Add `findByIds(ids: string[]): Promise<Memory[]>` to `MemoryRepository` interface and Drizzle implementation. Refactor `listForMemory` and `listBetweenMemories` to batch-load all related memories in one query, then look up from a Map. Eliminates the N+1 pattern.

### Confidence validation

Add a range check in both `create()` and `createInternal()`: if `confidence` is provided and outside 0–1, throw `ValidationError`. Defense-in-depth for callers that bypass Zod.

### Logging additions

Add operation logging to `RelationshipService`:

- `create()` / `createInternal()` — `logger.debug()` on successful creation (ID, type, source→target)
- `remove()` — `logger.debug()` on successful removal (ID)
- `archiveByMemoryId()` — `logger.info()` with count of archived relationships

Add to `memory-service.ts` archive path:

- `logger.info()` for relationship archival count during memory archive

## 3. Type Safety Improvements

### `Relationship.type`

Change from `string` to `WellKnownRelationshipType | (string & {})`. Provides autocomplete for well-known types while accepting arbitrary strings. Propagate to `RelationshipWithMemory`, `CreateRelationshipInput`, and Envelope meta.

### `RelatedMemorySummary`

Change `type: string` and `scope: string` to `MemoryType` and `MemoryScope` from `memory.ts`.

### `RelationshipWithMemory`

Derive from `Relationship` using `Omit<Relationship, 'project_id' | 'archived_at'>` plus enrichment fields (`direction`, `related_memory`). Eliminates 8 duplicated fields.

### `RelationshipSummary`

Extract a named type using `Pick<Relationship, 'id' | 'type' | 'description' | 'confidence' | 'source_id' | 'target_id'>`. Use in `Envelope.meta.relationships` replacing the inline anonymous object.

### Confidence JSDoc

Add `/** Value between 0 and 1 inclusive */` to all `confidence` fields.

## 4. Documentation Fixes

### README updates

- `memory_relate` signature — expand to include optional parameters (`description?`, `confidence?`, `created_via?`)
- `memory_unrelate` — clarify that `id` is the relationship ID, not a memory ID
- `memory_relationships` — mark `direction` as optional with default `"both"`
- "How relationships work" — update to reflect that `memory_unrelate` now soft-deletes
- Response shape difference — note that `memory_get` returns relationships with `related_memory` summaries while `session_start` returns minimal data (IDs and type only)
- Well-known types table — match ordering to the `WELL_KNOWN_RELATIONSHIP_TYPES` array

### Inline comments

- `listBetweenMemories` — explain that `direction` is always `"outgoing"` because it represents the graph edge, not a per-memory perspective
- `createInternal()` — explain the privilege model and relationship to `memory_consolidate`

## 5. Tests

### `remove()` access control negative test

Create a non-consolidation relationship where source is Alice's user-scoped memory and target is a workspace memory. Attempt `remove()` as Bob (can access target but not source). Assert `NotFoundError`.

### API route tests for 3 new endpoints

Test `memory_relate`, `memory_unrelate`, and `memory_relationships` through the REST API layer. Verify Zod validation (reject bad input), response shapes, and error responses.

### `listForMemory` access control filtering

Create a relationship from a workspace memory to Bob's user-scoped memory. Call `listForMemory` as Alice. Assert the relationship is excluded from results.

### Strengthen consolidation relationship tests

Replace `expect(rels.length).toBeGreaterThanOrEqual(0)` with meaningful assertions. Either use content that triggers mock embedding thresholds, or directly test the consolidation→relationship creation path with assertions on type and confidence.

## Not Changing

- The existing `create()` method's access control behavior (MCP/REST callers still validated)
- Flag lifecycle or flag details schema
- Comments, audit log, embedding pipeline
- `memory_search`, `memory_list`

## Decisions Log

| Decision                    | Choice                              | Rationale                                                           |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `memory_unrelate` deletion  | Soft-delete                         | Matches spec's cascade philosophy, consistent with archive behavior |
| Consolidation access bypass | `createInternal()` method           | Clean public/internal split; MCP tool boundary unchanged            |
| N+1 fix                     | Add `findByIds` to MemoryRepository | Small effort, clean fix, reusable                                   |
| Orphaned relationships (#7) | Dropped                             | Non-issue once auto-archive cascade is fixed                        |
| `source` field rename       | `created_via` with DB migration     | Eliminates confusion with `source_id`                               |
| Fix delivery                | Single commit on feature branch     | Fixes belong with the feature, not separate PR                      |
