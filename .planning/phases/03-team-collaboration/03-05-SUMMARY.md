---
phase: 03-team-collaboration
plan: 05
subsystem: database
tags: [drizzle, postgres, sql, team-activity, comments]

# Dependency graph
requires:
  - phase: 03-04
    provides: countTeamActivity method and TeamActivityCounts interface in memory-repository.ts
provides:
  - commented_memories count derived from real SQL COUNT DISTINCT query on comments table
  - Integration test proving commented_memories >= 1 after comment between sessions
affects: [session-start, team-activity, memory-repository]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Third parallel query in Promise.all for commented_memories — follows existing pattern for new_memories and updated_memories"
    - "innerJoin on comments->memories to filter by project_id and archived_at within a count query"

key-files:
  created: []
  modified:
    - src/repositories/memory-repository.ts
    - tests/integration/team-activity.test.ts

key-decisions:
  - "All comments count toward commented_memories regardless of author — D-30 rule: team_activity includes user's own changes"
  - "COUNT DISTINCT on comments.memory_id to count distinct commented memories, not total comments"
  - "Filter comments by created_at > since (not memory updated_at) for accurate comment-time attribution"

patterns-established:
  - "Gap closure pattern: hardcoded 0 replaced with real SQL query matching same Promise.all structure"

requirements-completed: [TEAM-01, TEAM-02, TEAM-03, TEAM-04, TEAM-05, TEAM-06, TEAM-07]

# Metrics
duration: 5min
completed: 2026-03-23
---

# Phase 3 Plan 05: Fix commented_memories Always Returning 0 Summary

**Replaced hardcoded `commented_memories: 0` in countTeamActivity with a COUNT DISTINCT SQL query on the comments table joined to memories, and added an integration test proving the count is >= 1 after a comment is made between sessions.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-23T21:57:00Z
- **Completed:** 2026-03-23T21:59:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Fixed the gap identified in 03-VERIFICATION.md (truth #21): `commented_memories` was always 0 regardless of actual comment activity
- Added a third parallel SQL query in `countTeamActivity()` using `COUNT DISTINCT comments.memory_id` with an `innerJoin` on memories to filter by `project_id` and `archived_at`
- Added integration test `team_activity.commented_memories counts commented memories since last session` that asserts `>= 1` after bob comments on alice's memory
- Strengthened existing type-check test with `toBeGreaterThanOrEqual(0)` value range assertion
- All 107 tests pass with no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix countTeamActivity to query comments table for commented_memories** - `52b74b6` (fix)
2. **Task 2: Add integration test asserting commented_memories > 0 after comment** - `403d528` (test)

**Plan metadata:** (docs commit pending)

## Files Created/Modified

- `src/repositories/memory-repository.ts` - Replaced hardcoded `commented_memories: 0` with real SQL query using COUNT DISTINCT; updated Promise.all destructuring to include `commentedCount`
- `tests/integration/team-activity.test.ts` - Added new integration test for commented_memories > 0; strengthened existing type-check test

## Decisions Made

- All comments count toward `commented_memories` regardless of who made them — D-30 rule says team_activity includes user's own changes, so no author filter
- Used `COUNT DISTINCT comments.memory_id` rather than `COUNT(*)` to count distinct memories with comments, not total comment count
- Filter by `comments.created_at > since` (not memory's `updated_at`) because the query is specifically about when comments were posted

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - the fix was straightforward. The `comments` import was already present in memory-repository.ts, and `innerJoin` is a Drizzle query builder method (not an import), so no import changes were needed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All TEAM-01 through TEAM-07 requirements completed
- Phase 03 team-collaboration is now fully executed
- team_activity.commented_memories now returns accurate data for session start context

---
*Phase: 03-team-collaboration*
*Completed: 2026-03-23*
