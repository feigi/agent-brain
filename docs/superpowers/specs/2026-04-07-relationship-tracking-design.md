# Relationship Tracking Design

**Date:** 2026-04-07
**Status:** Approved

## Overview

Add first-class, directional, pairwise relationships between memories. Relationships describe how memories connect structurally (e.g., "A overrides B", "C implements D") and replace the relationship data currently embedded in consolidation flags.

## Data Model

### `relationships` table

| Column        | Type                    | Notes                                                    |
| ------------- | ----------------------- | -------------------------------------------------------- |
| `id`          | string (nanoid)         | Primary key                                              |
| `project_id`  | string                  | Same isolation as memories                               |
| `source_id`   | string (FK -> memories) | The "from" memory                                        |
| `target_id`   | string (FK -> memories) | The "to" memory                                          |
| `type`        | string                  | Freeform with well-known defaults (see below)            |
| `description` | string, nullable        | Optional context explaining the relationship             |
| `confidence`  | float (0-1)             | Default 1.0 for manual/agent, computed for consolidation |
| `created_by`  | string                  | User or agent who created it                             |
| `source`      | string, nullable        | `manual`, `agent-auto`, `consolidation`                  |
| `archived_at` | timestamp, nullable     | Soft-delete, set when either memory is archived          |
| `created_at`  | timestamp               | UTC                                                      |

### Well-known relationship types

Freeform string with documented defaults. No enum — promotion of new types is a documentation change, not a data migration.

- **`overrides`** — source replaces/supersedes target's guidance
- **`implements`** — source is a concrete realization of target
- **`refines`** — source adds detail to target without replacing it
- **`contradicts`** — source and target are in tension (agent/user created only, never consolidation)
- **`duplicates`** — source is a duplicate of target (consolidation-detected)

### Constraints

- Unique on `(project_id, source_id, target_id, type)` — no duplicate edges of the same type
- Check: `source_id != target_id`
- Always directional — for symmetric types like `contradicts`, newer memory is conventionally the source

### Indexes

- `(source_id)` — outgoing relationships
- `(target_id)` — incoming relationships
- `(project_id, type)` — list by type within a project

## MCP Tools

### `memory_relate` (new)

Creates a relationship between two memories.

- **Inputs:** `source_id`, `target_id`, `type`, `description?`, `confidence?` (default 1.0), `user_id`
- **Outputs:** The created relationship
- **Validation:** Both memories must exist and be accessible to the user
- **Dedup:** If a relationship of the same type already exists between the pair, return the existing one

### `memory_unrelate` (new)

Removes a relationship.

- **Inputs:** `id` (relationship ID), `user_id`
- **Outputs:** Success confirmation
- **Access control:** If you can edit the source memory, you can manage its relationships

### `memory_relationships` (new)

Lists relationships for a memory.

- **Inputs:** `memory_id`, `direction?` (`outgoing` | `incoming` | `both`, default `both`), `type?` (filter), `user_id`
- **Outputs:** Array of relationships with related memory summary (id, title, type, scope)

No update tool — delete and recreate if wrong.

## Modified Tools

### `memory_get`

Add a `relationships` array to the response containing both incoming and outgoing relationships with related memory summaries (id, title, type, scope).

### `memory_session_start`

After returning relevant memories, compute relationships _between the returned memories_ and include them. Only relationships where both sides are in the result set — avoids fetching the full graph.

### `memory_archive`

When a memory is archived, soft-delete all its relationships (set `archived_at`). If a memory were un-archived, relationships are restored only if the other side is still active.

## Consolidation Refactoring

### Relationship creation replaces embedded references

When consolidation detects a pair:

1. Create a relationship (e.g., `duplicates` at confidence 0.92)
2. Create a flag referencing the `relationship_id` instead of embedding `related_memory_id` in details
3. Flag becomes a pure action item: "review this relationship"

### Flag `details` schema change

- **Current:** `{ related_memory_id?, similarity?, reason }`
- **New:** `{ relationship_id?, reason }` — similarity lives on the relationship as `confidence`

### Mapping of flag types to relationships

| Flag type    | Creates relationship?               | Relationship type |
| ------------ | ----------------------------------- | ----------------- |
| `duplicate`  | Yes                                 | `duplicates`      |
| `superseded` | Yes                                 | `overrides`       |
| `verify`     | No — single-memory, no relationship | —                 |

Flag types `contradiction` and `override` are dropped — these become relationships, not flags. Remaining flag types: `duplicate`, `superseded`, `verify`.

Auto-archive behavior is unchanged. High-similarity same-scope pairs still auto-archive, but a relationship is created before archiving for provenance.

## Access Control

1. **Creating:** Must have read access to both memories
2. **Viewing:** Only return relationships where the user can read both sides
3. **Deleting:** Can edit source memory -> can manage its outgoing relationships. Consolidation-created relationships can be deleted by anyone with access to either side.
4. **Cross-scope relationships are allowed and expected** — the core use case ("workspace overrides project") is inherently cross-scope

## Cascade Behavior

Soft-delete via `archived_at` on the relationship, mirroring how memories work. No hard deletes via FK cascade — preserves history for audit and consolidation.

## Migration

1. Create `relationships` table
2. Backfill: extract existing flag `related_memory_id` data into relationships, update flag details to reference relationship IDs
3. One-time idempotent migration script

## Not Changing

- Comments, audit log, budget system, embedding pipeline
- Flag lifecycle (create/resolve) — flags just reference relationships now
- `memory_search`, `memory_list` — kept lightweight, no relationship data
