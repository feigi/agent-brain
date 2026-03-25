---
phase: 01-foundation-and-core-memory
plan: 02
subsystem: embedding, repository, service
tags:
  [
    embedding-provider,
    titan-v2,
    pgvector,
    cosine-similarity,
    drizzle-orm,
    cursor-pagination,
    optimistic-locking,
  ]

# Dependency graph
requires:
  - phase: 01-foundation-and-core-memory
    provides: "Drizzle schema (memories, projects), TypeScript types, utility modules, Docker Postgres"
provides:
  - "EmbeddingProvider interface with Titan V2 and Mock implementations"
  - "MemoryRepository interface with Drizzle/pgvector implementation (CRUD, search, list, stale, verify)"
  - "ProjectRepository with auto-create on first mention"
  - "MemoryService orchestrating embedding + storage with project/user scoping"
  - "Factory function for embedding provider selection via EMBEDDING_PROVIDER env var"
affects: [01-03, 01-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    [
      embedding-provider-interface,
      repository-pattern,
      constructor-injection,
      cursor-based-pagination,
      optimistic-locking,
      cosine-similarity-search,
      auto-title-generation,
    ]

key-files:
  created:
    [
      src/providers/embedding/types.ts,
      src/providers/embedding/titan.ts,
      src/providers/embedding/mock.ts,
      src/providers/embedding/index.ts,
      src/repositories/types.ts,
      src/repositories/memory-repository.ts,
      src/repositories/project-repository.ts,
      src/services/memory-service.ts,
    ]
  modified: []

key-decisions:
  - "Similarity filtering done in application layer after pgvector query rather than in SQL WHERE clause -- cosineDistance returns a distance, and computing 1-distance in WHERE is complex; application filtering is simpler and correct"
  - "Cursor pagination encodes created_at + id as compound cursor for stable ordering across pages"
  - "MemoryService.list serializes cursor as 'created_at|id' string in Envelope meta for transport simplicity"

patterns-established:
  - "Embedding provider interface: embed(text) -> number[], modelName, dimensions -- swappable via env var"
  - "Repository pattern: interfaces in types.ts, Drizzle implementations separate -- constructor injection into service"
  - "D-44 column selection: explicit memoryColumns object excludes embedding vector from all Memory returns"
  - "Cursor pagination: fetch limit+1, detect has_more, compound cursor (timestamp + id) for deterministic ordering"
  - "Optimistic locking: version check in UPDATE WHERE clause, ConflictError on mismatch"

requirements-completed: [INFR-02, INFR-03, SCOP-01, SCOP-02, SCOP-04]

# Metrics
duration: 4min
completed: 2026-03-23
---

# Phase 01 Plan 02: Embedding Provider and Service Layer Summary

**EmbeddingProvider abstraction with Titan/Mock implementations, Drizzle repository layer with cosine similarity search and cursor pagination, and MemoryService orchestrating all 8 memory operations with project/user scoping**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-23T03:35:08Z
- **Completed:** 2026-03-23T03:39:00Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- EmbeddingProvider interface with Amazon Titan V2 (512d, Bedrock InvokeModelCommand) and deterministic Mock implementation for dev/test
- Factory function selects provider based on EMBEDDING_PROVIDER env var ("titan" or "mock")
- DrizzleMemoryRepository implementing all 8 repository methods: create, findById, update (optimistic locking), archive (nulls embedding), search (cosine similarity), list (cursor pagination with type/tag filters), findStale, verify
- DrizzleProjectRepository with auto-create on first mention (D-34)
- MemoryService orchestrating embedding generation + storage for all operations: create, get, update, archive, search, list, verify, listStale
- Project scoping (SCOP-01), user scoping (SCOP-02), and app-level cross-project filtering (SCOP-04) in all query paths

## Task Commits

Each task was committed atomically:

1. **Task 1: Embedding provider interface and implementations** - `75b61d2` (feat)
2. **Task 2: Repository interfaces, implementations, and memory service** - `59f4ca1` (feat)

## Files Created/Modified

- `src/providers/embedding/types.ts` - EmbeddingProvider interface (embed, modelName, dimensions)
- `src/providers/embedding/titan.ts` - Amazon Titan V2 implementation with Bedrock client, 32K char truncation
- `src/providers/embedding/mock.ts` - Deterministic mock using sine-hash vectors (512d)
- `src/providers/embedding/index.ts` - Factory function + re-exports
- `src/repositories/types.ts` - MemoryRepository, ProjectRepository interfaces with ListOptions, SearchOptions, StaleOptions
- `src/repositories/memory-repository.ts` - Drizzle/pgvector implementation with cosineDistance, cursor pagination, optimistic locking
- `src/repositories/project-repository.ts` - Auto-create projects on first mention with race condition handling
- `src/services/memory-service.ts` - Business logic orchestrating embedding + storage with timing in all responses

## Decisions Made

- Similarity filtering done in application layer after pgvector query -- computing `1 - cosineDistance()` in a SQL WHERE clause is complex; application-layer filtering on the ordered results is simpler and correct for the expected result set sizes
- Cursor pagination uses compound cursor (timestamp + id) for deterministic ordering, serialized as `created_at|id` string in Envelope meta
- ProjectRepository.findOrCreate uses `onConflictDoNothing` + re-select for race condition safety

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Known Stubs

None - all files are fully implemented with no placeholder data.

## Next Phase Readiness

- Service layer complete and ready for MCP tool handlers (Plan 03)
- All 8 memory operations (create, get, update, archive, search, list, verify, listStale) available via MemoryService
- EmbeddingProvider abstraction ready for both development (mock) and production (titan)
- Repository interfaces enable test mocking without database dependency

## Self-Check: PASSED

All 8 key files verified present. Both task commits (75b61d2, 59f4ca1) verified in git history.

---

_Phase: 01-foundation-and-core-memory_
_Completed: 2026-03-23_
