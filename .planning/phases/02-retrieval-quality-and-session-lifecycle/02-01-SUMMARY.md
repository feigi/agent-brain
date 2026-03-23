---
phase: 02-retrieval-quality-and-session-lifecycle
plan: 01
subsystem: api
tags: [scoring, relevance, exponential-decay, pgvector, vitest]

# Dependency graph
requires:
  - phase: 01-foundation-and-core-memory
    provides: "Memory types, repository interfaces, service layer, config pattern"
provides:
  - "computeRelevance() and exponentialDecay() pure scoring functions"
  - "MemoryWithRelevance type (renamed from MemoryWithScore)"
  - "recencyHalfLifeDays config with RECENCY_HALF_LIFE_DAYS env var"
  - "OVER_FETCH_FACTOR constant for re-ranking strategy"
affects: [02-02, 02-03]

# Tech tracking
tech-stack:
  added: []
  patterns: ["exponential decay for recency scoring", "composite relevance = similarity(80%) + recency(15%) + verification(5%)"]

key-files:
  created:
    - src/utils/scoring.ts
    - tests/unit/scoring.test.ts
  modified:
    - src/types/memory.ts
    - src/config.ts
    - src/repositories/types.ts
    - src/repositories/memory-repository.ts
    - src/services/memory-service.ts
    - tests/integration/memory-search.test.ts

key-decisions:
  - "Composite relevance formula: 0.80*similarity + 0.15*recency + 0.05*verified"
  - "Recency uses exponential decay with configurable half-life (default 14 days)"
  - "Repository search still returns raw cosine similarity as 'relevance' -- composite scoring applied by service layer in Plan 02"

patterns-established:
  - "Pure scoring functions in src/utils/scoring.ts -- no side effects, fully testable"
  - "Unit tests in tests/unit/ using explicit dates for determinism"

requirements-completed: [RETR-02, RETR-03]

# Metrics
duration: 4min
completed: 2026-03-23
---

# Phase 02 Plan 01: Scoring Foundation Summary

**Pure scoring functions (exponentialDecay, computeRelevance) with TDD tests and MemoryWithScore-to-MemoryWithRelevance type rename across the codebase**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-23T13:51:36Z
- **Completed:** 2026-03-23T13:55:58Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Implemented exponentialDecay() and computeRelevance() pure scoring functions with 15 unit tests (TDD)
- Renamed MemoryWithScore to MemoryWithRelevance with cascading updates across 6 source/test files
- Extended config with recencyHalfLifeDays (RECENCY_HALF_LIFE_DAYS env var, default 14)
- Exported OVER_FETCH_FACTOR constant (3) for re-ranking strategy in Plan 02

## Task Commits

Each task was committed atomically:

1. **Task 1: Scoring functions and unit tests** - `1ebd159` (test: RED), `c8adf0d` (feat: GREEN)
2. **Task 2: Rename MemoryWithScore to MemoryWithRelevance and extend config** - `6415411` (feat)

_Note: Task 1 used TDD with separate RED/GREEN commits._

## Files Created/Modified
- `src/utils/scoring.ts` - Pure scoring functions: exponentialDecay, computeRelevance, weight constants
- `tests/unit/scoring.test.ts` - 15 unit tests covering decay, composite scoring, clamping, constants
- `src/types/memory.ts` - MemoryWithRelevance type (renamed from MemoryWithScore)
- `src/config.ts` - Added recencyHalfLifeDays config field
- `src/repositories/types.ts` - Updated search() return type to MemoryWithRelevance
- `src/repositories/memory-repository.ts` - Updated search() return type and field mapping
- `src/services/memory-service.ts` - Updated search() return type
- `tests/integration/memory-search.test.ts` - Updated property assertions from similarity to relevance

## Decisions Made
- Composite relevance formula: 0.80*similarity + 0.15*recency_decay + 0.05*verified_boost -- per D-01/D-02/D-03
- Recency decay uses `pow(0.5, ageDays/halfLifeDays)` for mathematically clean half-life behavior
- Repository search maps raw cosine similarity to `relevance` field now -- composite scoring will be layered on top by service in Plan 02

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated integration tests for field rename**
- **Found during:** Task 2 (type rename)
- **Issue:** Integration tests in tests/integration/memory-search.test.ts referenced `.similarity` property which no longer exists on MemoryWithRelevance
- **Fix:** Renamed all `.similarity` property accesses to `.relevance` in integration test assertions
- **Files modified:** tests/integration/memory-search.test.ts
- **Verification:** TypeScript compiles cleanly (`npx tsc --noEmit` exits 0)
- **Committed in:** 6415411 (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Integration test update was necessary to maintain a working test suite after the type rename. No scope creep.

## Issues Encountered
- Vitest v4 does not support `-x` flag for bail-on-first-failure; used `--bail 1` instead

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Scoring functions ready for Plan 02 (service-layer re-ranking integration)
- MemoryWithRelevance type available for all downstream consumers
- Config pattern for recencyHalfLifeDays established for Plan 02 to wire into service

## Self-Check: PASSED

All 8 files verified present. All 3 commit hashes verified in git log.

---
*Phase: 02-retrieval-quality-and-session-lifecycle*
*Completed: 2026-03-23*
