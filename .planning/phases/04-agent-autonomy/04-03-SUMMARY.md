---
phase: 04-agent-autonomy
plan: 03
subsystem: memory
tags: [pgvector, cosine-similarity, budget-enforcement, dedup, autonomous-write]

# Dependency graph
requires:
  - phase: 04-01
    provides: sessions table, SessionRepository interface, CreateSkipResult type, config.writeBudgetPerSession, config.duplicateThreshold
provides:
  - findDuplicates method on MemoryRepository interface and DrizzleMemoryRepository implementation
  - Three-stage pre-save guard chain in memory_create (session validation, budget check, dedup)
  - Soft-reject CreateSkipResult responses for budget_exceeded and duplicate reasons
  - Post-insert budget increment for autonomous writes
affects: [04-04, memory-create pipeline, autonomous-write flow]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Guard chain pattern: session validation -> budget check -> embed -> dedup -> insert -> increment"
    - "Soft-reject pattern: service returns CreateSkipResult discriminated union instead of throwing for rate/quality limits"
    - "Scope-aware dedup: user-scoped memories check both user and project scope (D-16)"

key-files:
  created: []
  modified:
    - src/repositories/types.ts
    - src/repositories/memory-repository.ts
    - src/services/memory-service.ts
    - src/tools/memory-create.ts

key-decisions:
  - "Guard order: session validation before budget check before embedding before dedup -- fail fast on cheapest checks"
  - "Dedup runs after embedding to reuse the embedding for both dedup and insert -- avoids double embed call"
  - "Budget check reads limit from getBudget() not config directly -- session can have custom limit"
  - "Post-insert increment not pre-insert decrement -- avoids decrementing on failures (embedding error, dedup skip)"

patterns-established:
  - "findDuplicates: limit 1, filter in application layer (same pattern as search min_similarity)"
  - "isAutonomous helper derived from source field -- centralizes autonomous detection logic"

requirements-completed: [AUTO-04, AUTO-05]

# Metrics
duration: 1min
completed: 2026-03-23
---

# Phase 04 Plan 03: Write Budget and Semantic Dedup Guard Chain Summary

**Three-stage pre-save guard chain for memory_create: session_id validation, per-session write budget enforcement with soft-reject, and cosine similarity duplicate detection with scope-aware filtering**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-23T22:38:37Z
- **Completed:** 2026-03-23T22:40:17Z
- **Tasks:** 1
- **Files modified:** 4

## Accomplishments
- Added `findDuplicates` method to `MemoryRepository` interface and implemented in `DrizzleMemoryRepository` using cosine similarity with scope-aware filtering (D-16: user-scoped dedup checks both user and project scope)
- Implemented three-stage pre-save guard chain in `MemoryService.create()`: (1) `ValidationError` for autonomous writes without `session_id`, (2) soft-reject `budget_exceeded` when session budget exhausted, (3) soft-reject `duplicate` when similarity >= threshold
- Manual writes (`source: 'manual'`) bypass budget checks entirely as designed
- Post-insert budget increment via `incrementBudgetUsed` after successful autonomous saves, with budget info included in response meta

## Task Commits

Each task was committed atomically:

1. **Task 1: Duplicate detection repository method and memory_create guard chain** - `e1afb9c` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified
- `src/repositories/types.ts` - Added `findDuplicates` to `MemoryRepository` interface
- `src/repositories/memory-repository.ts` - Implemented `findDuplicates` with cosine distance and scope-aware WHERE clause
- `src/services/memory-service.ts` - Three-stage guard chain in `create()`, updated return type to `Envelope<Memory | CreateSkipResult>`
- `src/tools/memory-create.ts` - Updated description to document `session_id` requirement for autonomous writes

## Decisions Made
- Guard order puts session validation and budget check before embedding generation -- fails fast on the cheapest checks before incurring embedding API cost
- Dedup runs after embedding is generated, reusing that vector for both duplicate detection and the eventual insert -- avoids a double embed call
- Budget check reads `used`/`limit` from `getBudget()` (session record) rather than comparing against config directly -- supports future per-session custom limits
- Post-insert increment (not pre-insert decrement) avoids incorrectly consuming budget when the write fails due to embedding error or dedup skip

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Budget enforcement and dedup guards complete; `memory_create` pipeline is fully hardened for autonomous agent use
- Plan 04 (session-review tool) can now depend on the complete autonomous write pipeline

---
*Phase: 04-agent-autonomy*
*Completed: 2026-03-23*
