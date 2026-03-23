---
phase: 03-team-collaboration
plan: 02
subsystem: service-tools
tags: [access-control, slug-validation, content-validation, scope-enforcement, multi-user]

# Dependency graph
requires:
  - phase: 03-team-collaboration
    plan: 01
    provides: slugSchema, contentSchema, AuthorizationError, comments table, sessionTracking table, verified_by/last_comment_at columns

provides:
  - Repository comment_count via correlated SQL subquery on all SELECT queries
  - MemoryService.canAccess() and assertCanModify() access control helpers
  - Scope enforcement on get, update, archive, verify, listStale, search
  - All 9 tools validated with slugSchema for user_id and project_id
  - memory-get, memory-verify, memory-list-stale have user_id as required parameter
  - memory-search and memory-list have user_id upgraded from optional to required
  - memory-create and memory-update use contentSchema for content field

affects: [03-03, 03-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Correlated subquery for comment_count: baseMemoryColumns for INSERT/UPDATE RETURNING, memoryColumns() method for SELECT queries"
    - "Access control pattern: canAccess(memory, userId) returns bool; assertCanModify throws AuthorizationError"
    - "Not-found masking for user-scoped memories: get() returns NotFoundError (not AuthorizationError) to non-owners (D-17)"
    - "Re-fetch after mutation: update() and verify() return results via findById() to include comment_count from correlated subquery"

key-files:
  created: []
  modified:
    - src/repositories/memory-repository.ts
    - src/services/memory-service.ts
    - src/tools/memory-create.ts
    - src/tools/memory-get.ts
    - src/tools/memory-update.ts
    - src/tools/memory-archive.ts
    - src/tools/memory-search.ts
    - src/tools/memory-list.ts
    - src/tools/memory-verify.ts
    - src/tools/memory-list-stale.ts
    - src/tools/memory-session-start.ts
    - tests/helpers.ts
    - tests/integration/memory-crud.test.ts
    - tests/integration/memory-scoping.test.ts
    - tests/integration/memory-search.test.ts
    - tests/integration/session-start.test.ts

key-decisions:
  - "baseMemoryColumns (static) + memoryColumns() method (with correlated subquery): INSERT/UPDATE RETURNING cannot use correlated subqueries reliably; mutations re-fetch via findById to get comment_count"
  - "update() re-fetches memory for access control check before mutation -- avoids double-fetch by reusing the fetched record for both auth check and re-embedding logic"
  - "user_id required in search(): service signature change from optional to required -- tools enforce slug validation upstream"
  - "Not-found masking (D-17): get() returns NotFoundError for non-owners of user-scoped memories to prevent existence leakage"

# Metrics
duration: 7min
completed: 2026-03-23
---

# Phase 3 Plan 02: Service Access Control and Tool Retrofits Summary

**Scope-based access control layered into all 9 tools -- project memories shared, user memories private, comment_count live via SQL subquery on all queries**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-23T20:18:08Z
- **Completed:** 2026-03-23T20:25:16Z
- **Tasks:** 2
- **Files modified:** 16

## Accomplishments

- Repository `comment_count` implemented via correlated SQL subquery (`SELECT COUNT(*)::int FROM comments WHERE comments.memory_id = memories.id`) -- returned on every SELECT query
- `verify()` and `update()` re-fetch via `findById` after mutation to include live comment_count; INSERT/UPDATE RETURNING paths use `baseMemoryColumns` since correlated subqueries don't work in RETURNING
- `tests/helpers.ts` updated to delete `comments` and `sessionTracking` tables in FK-safe order before each test
- `MemoryService.canAccess()` and `assertCanModify()` helpers added; `AuthorizationError` imported
- `get()`, `update()`, `archive()`, `verify()`, `listStale()`, `search()` all accept `userId` and enforce scope-based access control
- All 9 tools retrofitted with `slugSchema` for `project_id` and `user_id`; `user_id` added to memory-get, memory-verify, memory-list-stale; made required (from optional) in memory-search and memory-list
- `contentSchema` applied to memory-create and memory-update for empty/whitespace content rejection
- `findRecentActivity()` updated with scope enforcement (project scope + own user-scoped memories only) and `gte(since)` logic

## Task Commits

Each task was committed atomically:

1. **Task 1: Repository layer comment_count, verify/update re-fetch, helpers FK-safe truncation** - `2743d87` (feat)
2. **Task 2: Service access control and all 9 tool retrofits** - `a3c85de` (feat)

## Files Created/Modified

- `src/repositories/memory-repository.ts` - baseMemoryColumns + memoryColumns() method, all SELECTs use correlated subquery, verify/update re-fetch via findById, findRecentActivity with scope enforcement
- `src/services/memory-service.ts` - canAccess/assertCanModify helpers, userId on get/update/archive/verify/listStale, search userId required
- `src/tools/memory-create.ts` - slugSchema for project_id/user_id, contentSchema for content
- `src/tools/memory-get.ts` - user_id added as required parameter with slugSchema
- `src/tools/memory-update.ts` - slugSchema for project_id/user_id, contentSchema.optional() for content, passes userId to service
- `src/tools/memory-archive.ts` - slugSchema for user_id, passes userId to service
- `src/tools/memory-search.ts` - slugSchema for project_id/user_id, user_id required (not optional)
- `src/tools/memory-list.ts` - slugSchema for project_id/user_id, user_id required (not optional)
- `src/tools/memory-verify.ts` - slugSchema for user_id (was z.string())
- `src/tools/memory-list-stale.ts` - slugSchema for project_id, user_id added as required, passes userId to service
- `src/tools/memory-session-start.ts` - slugSchema for project_id and user_id
- `tests/helpers.ts` - import comments/sessionTracking, delete in FK-safe order
- Integration tests - updated to pass userId to service methods matching new signatures

## Decisions Made

- `baseMemoryColumns` (static) vs `memoryColumns()` (method with subquery): INSERT/UPDATE RETURNING doesn't support correlated subqueries in Drizzle reliably; split into static base + method for SELECT queries; mutations re-fetch via `findById`
- `update()` fetches existing memory once for both access control and re-embedding -- avoids the double-fetch that the previous implementation had when `needsReEmbed` was true
- `user_id` required in `search()` service method to match the tools' enforcement; removed the `?` from the signature
- `get()` returns `NotFoundError` (not `AuthorizationError`) for non-owners of user-scoped memories -- prevents leaking that the memory exists

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated integration tests for new service method signatures**

- **Found during:** Task 2 (after updating service method signatures)
- **Issue:** All integration tests called service methods with old signatures -- `get(id)` instead of `get(id, userId)`, `update(id, ver, updates)` instead of `update(id, ver, updates, userId)`, `archive(ids)` instead of `archive(ids, userId)`, `listStale(project, days)` instead of `listStale(project, userId, days)`, `search(...)` with `undefined` for user_id
- **Fix:** Updated 4 test files to pass `userId` arguments; updated cross-scope "throws without user_id" test to instead verify that valid user_id works (the TypeScript type system now enforces user_id at compile time)
- **Files modified:** tests/integration/memory-crud.test.ts, tests/integration/memory-scoping.test.ts, tests/integration/memory-search.test.ts, tests/integration/session-start.test.ts
- **Commit:** a3c85de (included in Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 -- interface contract propagation into tests)

## Issues Encountered

None -- both tasks executed cleanly. TypeScript passed with zero errors after test fixes.

## User Setup Required

None.

## Next Phase Readiness

- All 9 tools now enforce slug validation and scope-based access control
- Service layer is the authority for access decisions; tools are thin validators
- Plans 03-03 and 03-04 can consume the updated service/tool interfaces
- `DrizzleCommentRepository` and `DrizzleSessionTrackingRepository` not yet implemented -- Plans 03-03/04 will implement them for comment_count population and session tracking

## Self-Check: PASSED

All files verified present. All commits verified in git log.
- FOUND: src/repositories/memory-repository.ts
- FOUND: src/services/memory-service.ts
- FOUND: src/tools/memory-create.ts ... (all 9 tools)
- FOUND: tests/helpers.ts
- FOUND: commit 2743d87 (Task 1)
- FOUND: commit a3c85de (Task 2)

---
*Phase: 03-team-collaboration*
*Completed: 2026-03-23*
