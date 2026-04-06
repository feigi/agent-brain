# Slim Memory Projections for List vs Detail Endpoints

## Problem

All endpoints return the full `Memory` object (20+ fields), including internal fields like `embedding_model`, `embedding_dimensions`, `version`, `session_id`, and `metadata`. This wastes tokens when memories are injected into agent context at session start, and is unnecessary for list-type responses where the consumer only needs enough to understand and triage.

## Design

Introduce two projection types that sit between the internal `Memory` type and the API consumer:

- **`MemorySummary`** — slim representation for list endpoints
- **`MemoryDetail`** — full representation (minus embedding internals) for the detail endpoint

### Field mapping

| Field                  | `MemorySummary` | `MemoryDetail` | Never exposed |
| ---------------------- | --------------- | -------------- | ------------- |
| `id`                   | yes             | yes            |               |
| `title`                | yes             | yes            |               |
| `content`              | yes             | yes            |               |
| `type`                 | yes             | yes            |               |
| `scope`                | yes             | yes            |               |
| `tags`                 | yes             | yes            |               |
| `author`               | yes             | yes            |               |
| `source`               | yes             | yes            |               |
| `created_at`           | yes             | yes            |               |
| `updated_at`           | yes             | yes            |               |
| `verified_at`          | yes             | yes            |               |
| `verified_by`          | yes             | yes            |               |
| `comment_count`        | yes             | yes            |               |
| `last_comment_at`      | yes             | yes            |               |
| `project_id`           |                 | yes            |               |
| `workspace_id`         |                 | yes            |               |
| `version`              |                 | yes            |               |
| `session_id`           |                 | yes            |               |
| `metadata`             |                 | yes            |               |
| `archived_at`          |                 | yes            |               |
| `embedding_model`      |                 |                | yes           |
| `embedding_dimensions` |                 |                | yes           |

### Derived types

- **`MemorySummaryWithRelevance`** — `MemorySummary` + `relevance: number`. Used by `session_start` and `search`.
- **`MemorySummaryWithChangeType`** — `MemorySummary` + `change_type: "created" | "updated" | "commented"`. Used by `list_recent`.

### Projection functions

Two functions in `src/types/memory.ts`:

- `toSummary(memory: Memory): MemorySummary` — picks the summary fields
- `toDetail(memory: Memory): MemoryDetail` — picks everything except embedding fields

All list-returning service methods call `toSummary()` before wrapping in `Envelope`. `getWithComments()` calls `toDetail()`.

## Affected endpoints

### List endpoints (return `MemorySummary` variants)

| Endpoint        | Current return type                | New return type                           |
| --------------- | ---------------------------------- | ----------------------------------------- |
| `session_start` | `Envelope<MemoryWithRelevance[]>`  | `Envelope<MemorySummaryWithRelevance[]>`  |
| `search`        | `Envelope<MemoryWithRelevance[]>`  | `Envelope<MemorySummaryWithRelevance[]>`  |
| `list`          | `Memory[]` in envelope             | `MemorySummary[]` in envelope             |
| `list_recent`   | `Envelope<MemoryWithChangeType[]>` | `Envelope<MemorySummaryWithChangeType[]>` |
| `list_stale`    | `Memory[]` in envelope             | `MemorySummary[]` in envelope             |

### Detail endpoint (returns `MemoryDetail`)

| Endpoint     | Current return type                    | New return type                                    |
| ------------ | -------------------------------------- | -------------------------------------------------- |
| `memory_get` | `MemoryGetResponse` (extends `Memory`) | `MemoryDetailGetResponse` (extends `MemoryDetail`) |

### Unchanged

- `memory_create`, `memory_update` — return full `Memory` after write (caller may need `version` for subsequent updates)
- `memory_archive`, `memory_verify`, `memory_comment` — write responses, unchanged
- Repository layer — still returns full `Memory` objects internally
- `Memory` interface — unchanged, remains the internal/DB representation
- MCP `toolResponse()` / REST `res.json()` — no changes, they serialize whatever the service returns
- Hook script — no changes, forwards raw JSON (just smaller now)

## Test impact

Existing tests that assert on response shape will need updating to expect the slimmed fields. No behavioral changes.
