---
phase: 02-retrieval-quality-and-session-lifecycle
plan: 02
subsystem: api
tags: [scoring, relevance, composite-ranking, cross-scope, pgvector, vitest]

# Dependency graph
requires:
  - phase: 02-retrieval-quality-and-session-lifecycle
    plan: 01
    provides: "computeRelevance(), OVER_FETCH_FACTOR, MemoryWithRelevance type, recencyHalfLifeDays config"
provides:
  - "Composite relevance scoring pipeline (over-fetch, re-rank) in service layer"
  - "Cross-scope search (scope='both') across repository, service, and tool layers"
  - "memory_search tool with 'both' scope option for agents"
  - "Clean API boundary: relevance field only, no raw similarity leaking"
affects: [02-03]

# Tech tracking
tech-stack:
  added: []
  patterns: ["over-fetch 3x and re-rank with composite scoring", "OR-based cross-scope SQL query in repository"]

key-files:
  created: []
  modified:
    - src/repositories/types.ts
    - src/repositories/memory-repository.ts
    - src/services/memory-service.ts
    - src/tools/memory-search.ts
    - tests/integration/memory-search.test.ts
    - tests/integration/memory-scoping.test.ts

key-decisions:
  - "Over-fetch 3x candidates at repository layer, re-rank with composite relevance in service layer"
  - "Cross-scope search uses single SQL query with OR condition (not two separate queries)"
  - "Raw SQL 'similarity' alias stripped in repository to prevent field leaking at API boundary"
  - "Test min_similarity thresholds set to -1 for mock embedding compatibility (mock embeddings can produce negative cosine similarity)"

patterns-established:
  - "Destructure to strip internal SQL aliases before returning from repository"
  - "Over-fetch factor applied at service layer, not repository -- repository remains a simple data access layer"

requirements-completed: [SCOP-03, RETR-01, RETR-03]

# Metrics
duration: 4min
completed: 2026-03-23
---

# Phase 02 Plan 02: Search Pipeline & Cross-Scope Summary

**Composite relevance scoring (similarity 80% + recency 15% + verification 5%) with over-fetch/re-rank pipeline and cross-scope search for interleaved project + user memories**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-23T13:57:50Z
- **Completed:** 2026-03-23T14:02:15Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Integrated composite relevance scoring into the search pipeline with over-fetch (3x) and re-rank strategy
- Added cross-scope search (scope='both') through all layers: repository SQL, service, and MCP tool
- Fixed raw SQL 'similarity' alias leaking through to API boundary -- results now contain only 'relevance'
- Added cross-scope integration tests and updated all test thresholds for mock embedding compatibility

## Task Commits

Each task was committed atomically:

1. **Task 1: Cross-scope search in repository and SearchOptions** - `a53d286` (feat)
2. **Task 2: Composite scoring in service layer, tool update, and test updates** - `231dbb9` (feat)

## Files Created/Modified
- `src/repositories/types.ts` - SearchOptions scope field now accepts 'both' (D-08)
- `src/repositories/memory-repository.ts` - Cross-scope OR-based SQL query and similarity alias stripping
- `src/services/memory-service.ts` - Over-fetch/re-rank pipeline with computeRelevance integration
- `src/tools/memory-search.ts` - memory_search tool scope enum expanded to include 'both'
- `tests/integration/memory-search.test.ts` - Cross-scope tests, user_id requirement test, threshold fixes
- `tests/integration/memory-scoping.test.ts` - Threshold fix for mock embedding compatibility

## Decisions Made
- Over-fetch 3x candidates at repository layer, then re-rank with composite relevance at service layer -- keeps repository as a simple data access layer while service handles scoring logic
- Cross-scope search uses single SQL query with OR condition rather than two separate queries -- avoids N+1 and simplifies result merging
- Stripped raw SQL 'similarity' alias in repository map to prevent internal column names from leaking to API boundary
- Set test min_similarity thresholds to -1 for mock embedding compatibility -- mock embeddings use deterministic sine-based vectors that can produce negative cosine similarity

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed raw SQL 'similarity' alias leaking into MemoryWithRelevance output**
- **Found during:** Task 2 (composite scoring integration)
- **Issue:** Repository search method spread `rowToMemory(row)` which included the SQL-computed `similarity` column alias. The `similarity` field leaked through to MemoryWithRelevance objects alongside the intended `relevance` field.
- **Fix:** Destructure `{ similarity: rawSim, ...memoryFields }` from the row before spreading to strip the SQL alias.
- **Files modified:** src/repositories/memory-repository.ts
- **Verification:** Cross-scope test asserts `(memory as any).similarity` is undefined; all 12 tests pass.
- **Committed in:** 231dbb9 (Task 2 commit)

**2. [Rule 1 - Bug] Fixed min_similarity=0 threshold filtering out mock embedding results**
- **Found during:** Task 2 (test execution)
- **Issue:** Mock embedding provider generates deterministic sine-based vectors that can produce negative cosine similarity. Tests using `min_similarity: 0` would filter these out at the repository layer, causing tests to return empty results.
- **Fix:** Changed test `min_similarity` thresholds from `0` to `-1` across memory-search.test.ts and memory-scoping.test.ts. Also relaxed `toBeGreaterThan(0)` to `toBeGreaterThanOrEqual(0)` for composite score assertion since clamping to [0,1] can produce exactly 0.
- **Files modified:** tests/integration/memory-search.test.ts, tests/integration/memory-scoping.test.ts
- **Verification:** All 12 integration tests pass consistently.
- **Committed in:** 231dbb9 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for correctness. The similarity leak fix ensures clean API boundaries. The threshold fix ensures test reliability with mock embeddings. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full composite relevance scoring pipeline operational for search queries
- Cross-scope search ready for session-start auto-load in Plan 03
- All integration tests green with mock embeddings
- Clean API boundary: only `relevance` field exposed, no raw `similarity`

## Self-Check: PASSED

All 6 files verified present. All 2 commit hashes verified in git log.

---
*Phase: 02-retrieval-quality-and-session-lifecycle*
*Completed: 2026-03-23*
