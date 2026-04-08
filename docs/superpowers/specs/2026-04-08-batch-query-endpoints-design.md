# Batch Query Endpoints

**Date:** 2026-04-08
**Status:** Draft

## Problem

Agents make excessive sequential tool calls for common read patterns. A "give me all memories" request results in N `memory_get` calls + N `memory_relationships` calls instead of 2 calls. Additionally, `memory_list` only accepts a single scope per call, requiring multiple calls to query across workspace and user scopes.

Contributing factor: the `memory_get` tool description doesn't mention that relationships are already included in the response, leading agents to make redundant `memory_relationships` calls.

## Design

### 1. `memory_list` — scope as array

**Before:** `scope: "workspace" | "user" | "project"` (single string)
**After:** `scope: string[]` (e.g. `["workspace", "user"]`)
**Default:** `["workspace"]`

Repository change: the WHERE clause iterates the scope array and ORs the per-scope conditions together. The existing `scope = 'project'` inclusion is deduplicated when multiple scopes would each add it.

Pagination, sorting, and response shape are unchanged. Each memory carries its `scope` property.

### 2. `memory_get` — batch IDs with optional includes

**Before:** `id: string` — returns full detail with comments, flags, relationships, capabilities
**After:**

```
ids: string[]
include?: ("comments" | "flags" | "relationships")[]
```

**Without `include`:** Returns memory detail with `comment_count`, `flag_count`, and `relationship_count` as numbers. No join overhead.

**With `include`:** Specified joins return full data arrays; the rest remain as counts. Example: `include: ["comments"]` returns full `comments` array but `flag_count` and `relationship_count` as numbers.

Capabilities (`can_edit`, `can_archive`, `can_verify`, `can_comment`) are always included per memory.

**Service layer:** New `getMany(ids, userId, include?)` method that:

- Batch-fetches memories via existing `findByIds(ids)`
- Filters by project isolation and access control (inaccessible memories silently omitted)
- Conditionally batch-fetches comments, flags, and/or relationships for the surviving IDs
- Maps results per memory

**Response shape:**

```typescript
{
  data: MemoryGetResponse[],  // array
  meta: { count: number, timing: number }
}
```

### 3. `memory_relationships` — batch memory IDs

**Before:** `memory_id: string`
**After:** `memory_ids: string[]`

Repository change: `findByMemoryIds` uses `IN (...)` instead of `= ?` for source/target ID filtering. Direction and type filters apply across all memories.

Response shape unchanged — flat list of `RelationshipWithMemory`.

### 4. `memory_search` — scope alignment

**Before:** `scope: "workspace" | "user" | "both"` (single string, `"both"` is special)
**After:** `scope: string[]` (e.g. `["workspace", "user"]`)
**Default:** `["workspace"]`

The `"both"` option is removed. `["workspace", "user"]` replaces it. The repository search query builds OR conditions per scope, same pattern as `memory_list`.

### 5. New correlated subqueries in `memoryColumns()`

Add alongside existing `comment_count`:

- **`flag_count`**: `SELECT COUNT(*) FROM flags WHERE flags.memory_id = memories.id AND flags.resolved_at IS NULL` (open flags only)
- **`relationship_count`**: `SELECT COUNT(*) FROM relationships WHERE (relationships.source_id = memories.id OR relationships.target_id = memories.id) AND relationships.archived_at IS NULL`

All counted foreign keys are indexed:

- `flags.memory_id` — `flags_memory_id_idx`
- `relationships.source_id` — `relationships_source_idx`
- `relationships.target_id` — `relationships_target_idx`

### 6. Tool descriptions

Update all four tool descriptions to:

- Document array parameters with examples
- Mention `include` parameter and counts-only default on `memory_get`
- Explicitly state that `memory_get` with `include: ["relationships"]` eliminates the need for a separate `memory_relationships` call
- Guide agents toward the optimal 2-call pattern: `memory_list` → `memory_get`

## Non-goals

- No new tools — all changes are in-place schema evolution
- No backward compatibility shims — single consumer, clean break
- No changes to write/mutation endpoints
- No changes to `memory_list_stale` or `memory_list_recent` (fixed workspace scope is fine)
