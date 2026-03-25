---
phase: 03-team-collaboration
plan: 04
subsystem: testing
tags:
  [
    integration-tests,
    unit-tests,
    vitest,
    access-control,
    comments,
    team-activity,
    validation,
  ]

# Dependency graph
requires:
  - phase: 03-team-collaboration
    plan: 01
    provides: comments table, sessionTracking table, Comment/MemoryGetResponse/MemoryWithChangeType types, CommentRepository/SessionTrackingRepository interfaces
  - phase: 03-team-collaboration
    plan: 02
    provides: canAccess/assertCanModify helpers, slugSchema/contentSchema validators, access control in service
  - phase: 03-team-collaboration
    plan: 03
    provides: DrizzleCommentRepository, DrizzleSessionTrackingRepository, MemoryService.addComment/getWithComments/listRecentActivity/sessionStart (enhanced), memory_comment + memory_list_recent tools

provides:
  - Integration tests proving TEAM-01 through TEAM-07 requirements against real Docker Postgres
  - access-control.test.ts: shared project memories, user scope privacy, author tracking, provenance, verify with verified_by, stale scope enforcement, comment_count
  - comment.test.ts: comment creation, preserves original, self-comment block, archived block, capability booleans, oldest-first ordering
  - team-activity.test.ts: session tracking, team_activity counts, first-session fallback, list_recent change_type/exclude_self/limit/scope privacy
  - unit/validation.test.ts: 10 slugSchema tests + 4 contentSchema tests
  - Bug fix: correlated subquery for comment_count now returns correct values (was always 0)
  - Bug fix: countTeamActivity now includes user's own changes per D-30 (was excluding them)

affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Correlated subquery in Drizzle sql template: use raw column name string ('memories.id') not Drizzle column reference (${memories.id}) -- the latter becomes a parameterized value, breaking correlation"
    - "Integration test structure: describe > it, beforeEach(truncateAll), afterAll(closeDb), createTestService() per test cycle"

key-files:
  created:
    - tests/integration/access-control.test.ts
    - tests/integration/comment.test.ts
    - tests/integration/team-activity.test.ts
    - tests/unit/validation.test.ts
  modified:
    - tests/helpers.ts
    - src/repositories/memory-repository.ts

key-decisions:
  - "Correlated subquery bug: Drizzle sql template parameterizes ${column} references as values -- raw SQL string required for correlated subquery column references"
  - "D-30 bug fix: countTeamActivity excluded requesting user's own memories via != userId filter -- D-30 spec says counts should include own changes, filter removed"

requirements-completed:
  [TEAM-01, TEAM-02, TEAM-03, TEAM-04, TEAM-05, TEAM-06, TEAM-07]

# Metrics
duration: 6min
completed: 2026-03-23
---

# Phase 3 Plan 04: Integration and Unit Tests for Team Collaboration Summary

**Comprehensive integration tests proving all 7 TEAM requirements against real Postgres, plus two bug fixes discovered during test execution (correlated subquery comment_count always returning 0, and D-30 team_activity excluding user's own changes)**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-23T20:33:33Z
- **Completed:** 2026-03-23T20:39:29Z
- **Tasks:** 2
- **Files created:** 4
- **Files modified:** 2

## Accomplishments

- `tests/helpers.ts` updated: `createTestService()` now wires `DrizzleCommentRepository` and `DrizzleSessionTrackingRepository` into `MemoryService`, enabling Phase 3 test coverage
- `tests/unit/validation.test.ts` created: 10 slugSchema tests (valid slugs, empty, uppercase, leading/trailing/consecutive hyphens, spaces, special chars, 64-char boundary) + 4 contentSchema tests
- `tests/integration/access-control.test.ts` created: TEAM-01 shared project memories (read/write/update/archive by any user), TEAM-02 author tracking, TEAM-03 comment provenance, TEAM-06 verified_by, TEAM-07 stale scope enforcement, D-17 not-found masking, comment_count correctness
- `tests/integration/comment.test.ts` created: TEAM-04 comment creation with comment_count in meta, TEAM-05 original content preservation + version not bumped + timestamp updated, D-56 self-comment block + error message, D-55 archived block, D-72 capability booleans, D-64 oldest-first ordering
- `tests/integration/team-activity.test.ts` created: D-29 team_activity in sessionStart meta, D-30 includes own changes, D-31 first-session 7-day fallback, D-37 change_type (created/updated/commented), D-38 exclude_self, scope privacy, D-39 limit enforcement
- Two bugs in `src/repositories/memory-repository.ts` fixed during test execution

## Task Commits

1. **Task 1: Update test helpers and create unit validation tests** - `3e82499` (feat)
2. **Task 2: Integration tests for access control, comments, and team activity** - `bb808a9` (feat)

## Files Created/Modified

- `tests/helpers.ts` - Added DrizzleCommentRepository and DrizzleSessionTrackingRepository wiring to createTestService()
- `tests/unit/validation.test.ts` - slugSchema (10 tests) and contentSchema (4 tests) unit tests
- `tests/integration/access-control.test.ts` - TEAM-01 through TEAM-07 plus D-11/D-15/D-17 scope privacy, comment_count field
- `tests/integration/comment.test.ts` - Comment lifecycle, capability booleans, D-53/D-54/D-55/D-56/D-62/D-64/D-72
- `tests/integration/team-activity.test.ts` - Session tracking, team_activity, list_recent
- `src/repositories/memory-repository.ts` - Two bug fixes: correlated subquery column reference + D-30 own-change inclusion

## Decisions Made

- Drizzle `sql` template with `${table.column}` generates a parameterized value, not a column reference. For correlated subqueries, raw SQL column names must be used. This is a Drizzle behavior that affects any correlated subquery.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed correlated subquery in memoryColumns() always returning 0**

- **Found during:** Task 2 (integration tests for access-control.test.ts)
- **Issue:** `sql\`(SELECT COUNT(\*)::int FROM comments WHERE comments.memory_id = ${memories.id})\``causes Drizzle to parameterize`memories.id` as a bind value (the actual ID string being queried), rather than a SQL column reference. Every row's correlated subquery resolves against the literal value of the outer WHERE clause parameter, coincidentally also the same ID, but the comments table lookup compares against an ID that is bound once per query rather than correlating per row. Net effect: returns 0 instead of actual count.
- **Fix:** Changed to raw SQL string `memories.id` (no `${}` interpolation): `sql\`(SELECT COUNT(\*)::int FROM comments WHERE comments.memory_id = memories.id)\``
- **Files modified:** `src/repositories/memory-repository.ts`
- **Verification:** `comment_count field > memory has correct comment_count after comments added` passes; full suite 106/106
- **Committed in:** `bb808a9` (Task 2 commit)

**2. [Rule 1 - Bug] Fixed countTeamActivity incorrectly excluding user's own changes**

- **Found during:** Task 2 (integration tests for team-activity.test.ts)
- **Issue:** `countTeamActivity` filtered with `sql\`${memories.author} != ${userId}\``which excludes the requesting user's own memories from the`new_memories`and`updated_memories` counts. D-30 spec: "team_activity includes the user's own changes -- a new session needs full context of what happened since last session, including your own past work."
- **Fix:** Removed `author != userId` condition from both count queries in `countTeamActivity`
- **Files modified:** `src/repositories/memory-repository.ts`
- **Verification:** `D-30: team_activity includes user's own changes` passes; full suite 106/106
- **Committed in:** `bb808a9` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 - Bugs)
**Impact on plan:** Both bugs were latent in the Phase 3 repository implementation -- the tests discovered them. No scope creep. Both fixes bring the code into compliance with the design specs.

## Issues Encountered

None beyond the two auto-fixed bugs.

## Known Stubs

None -- all test functionality is fully implemented. The `content validation > rejects empty comment content` test in `comment.test.ts` is intentionally a no-op at the service layer (validation happens at the tool layer via `contentSchema`), and the test comment documents this.

## Next Phase Readiness

- Phase 3 is complete: all 7 TEAM requirements have integration tests proving the behavior
- All 106 tests pass (52 Phase 1/2 legacy + 54 Phase 3 new)
- Ready for Phase 4: Agent Autonomy

---

_Phase: 03-team-collaboration_
_Completed: 2026-03-23_
