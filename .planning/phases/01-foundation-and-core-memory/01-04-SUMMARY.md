---
phase: 01-foundation-and-core-memory
plan: 04
subsystem: testing
tags: [vitest, integration-tests, pgvector, docker, seed-data, mcp-inspector]

# Dependency graph
requires:
  - phase: 01-foundation-and-core-memory/01-03
    provides: "MCP tool handlers and server entry point"
  - phase: 01-foundation-and-core-memory/01-02
    provides: "Memory service, repositories, and embedding providers"
  - phase: 01-foundation-and-core-memory/01-01
    provides: "Database schema, types, Docker setup"
provides:
  - "27-test integration test suite covering CRUD, search, and scoping"
  - "Test helper utilities (createTestService, truncateAll, closeDb)"
  - "Development seed script with 11 memories across 2 projects"
  - "End-to-end verified MCP server with all 8 tools functional"
affects: [phase-02, phase-03, phase-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Integration tests use MockEmbeddingProvider against real Docker Postgres"
    - "beforeEach truncateAll for clean test state (FK-safe delete order)"
    - "fileParallelism: false in vitest.config.ts for shared DB"
    - "Seed script uses MemoryService layer (not raw SQL) for realistic data creation"

key-files:
  created:
    - tests/helpers.ts
    - tests/integration/memory-crud.test.ts
    - tests/integration/memory-search.test.ts
    - tests/integration/memory-scoping.test.ts
    - scripts/seed.ts
  modified:
    - src/repositories/memory-repository.ts
    - src/db/index.ts
    - src/tools/memory-create.ts
    - src/tools/memory-list.ts
    - src/tools/memory-search.ts
    - src/tools/memory-update.ts
    - vitest.config.ts

key-decisions:
  - "Fixed cosine distance SQL operator precedence -- pgvector 1-distance requires parentheses around the <=> expression"
  - "Disabled vitest file parallelism -- integration tests share a single Docker Postgres instance"
  - "Suppressed PostgreSQL NOTICE messages on db connection -- prevents stdout corruption in MCP stdio transport"
  - "Added .catch() on optional Zod schema parse -- defends against MCP clients sending unexpected empty values"
  - "Reverted handler-level enum validation back to z.enum() in schemas after confirming client compatibility"

patterns-established:
  - "Test helper pattern: createTestService() wires MockEmbeddingProvider + real DB for integration tests"
  - "Truncation pattern: delete memories before projects (FK-safe order) in beforeEach"
  - "Seed script pattern: use service layer for data creation to exercise full stack including auto-project-creation"

requirements-completed: [CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, CORE-07, CORE-08, SCOP-01, SCOP-02, SCOP-04]

# Metrics
duration: ~25min (across sessions with human-verify checkpoint)
completed: 2026-03-23
---

# Phase 1 Plan 4: Integration Tests, Seed Script, and End-to-End Verification Summary

**27 integration tests validating CRUD, semantic search, and scoping against real Docker Postgres, plus seed script and human-verified MCP Inspector end-to-end flow**

## Performance

- **Duration:** ~25 min (across sessions with human-verify checkpoint)
- **Started:** 2026-03-23T03:53:58Z
- **Completed:** 2026-03-23T11:17:00Z
- **Tasks:** 3 (2 auto + 1 human-verify checkpoint)
- **Files created:** 5
- **Files modified:** 7

## Accomplishments

- 27 integration tests passing against real Docker Postgres with pgvector: 15 CRUD tests, 5 search tests, 5 scoping tests, 2 edge case tests
- Development seed script creating 11 diverse memories across 2 projects covering all 6 memory types
- Human-verified end-to-end MCP server: Inspector connects, all 8 tools listed, create/search/get cycle works
- Fixed 5 issues discovered during testing: SQL operator precedence, DB singleton reset, vitest parallelism, NOTICE message corruption, Zod schema defensiveness

## Task Commits

Each task was committed atomically:

1. **Task 1: Test helpers and integration test suite** - `b3c8c6d` (test)
2. **Task 2: Seed script for development** - `d6376ec` (feat)
3. **Task 3: Verify complete MCP server end-to-end** - N/A (human-verify checkpoint, approved)

Post-checkpoint fix commits (discovered during human verification):
- `ef0a20f` - fix(tools): harden Zod schemas against MCP Inspector empty-value quirks
- `0b43db0` - fix(db): suppress PostgreSQL NOTICE messages from stdout
- `539b770` - fix(tools): move enum validation to handler for MCP client compatibility
- `d45a2d5` - revert: restore z.enum() for type fields, remove handler workaround

## Files Created/Modified

- `tests/helpers.ts` - Test utilities: createTestService, truncateAll, closeDb, getTestDb
- `tests/integration/memory-crud.test.ts` - 15 CRUD operation tests (create, get, update, archive, verify, list)
- `tests/integration/memory-search.test.ts` - 5 semantic search tests (ranking, limit, archived exclusion, threshold, scores)
- `tests/integration/memory-scoping.test.ts` - 5 scoping tests (project isolation, user cross-project, auto-create project, stale detection)
- `scripts/seed.ts` - Development seed script: 11 memories across 2 projects, all 6 types
- `src/repositories/memory-repository.ts` - Fixed cosine distance SQL operator precedence
- `src/db/index.ts` - Added onnotice suppression for PostgreSQL NOTICE messages
- `src/tools/memory-create.ts` - Hardened Zod schema with .catch() on optional fields
- `src/tools/memory-list.ts` - Hardened Zod schema with .catch() on optional fields
- `src/tools/memory-search.ts` - Hardened Zod schema with .catch() on optional fields
- `src/tools/memory-update.ts` - Hardened Zod schema with .catch() on optional fields
- `vitest.config.ts` - Added fileParallelism: false for shared DB

## Decisions Made

1. **Cosine distance operator precedence** - pgvector's `<=>` operator in `1 - (a <=> b)` requires parentheses around the distance expression to avoid SQL parsing issues. Fixed inline in memory-repository.ts.
2. **Vitest file parallelism disabled** - Integration tests share a single Docker Postgres database; parallel execution caused table truncation race conditions. Set `fileParallelism: false` in vitest config.
3. **PostgreSQL NOTICE suppression** - `CREATE EXTENSION IF NOT EXISTS` emits NOTICE messages to stdout, which corrupts JSON-RPC framing in MCP stdio transport. Added `onnotice: () => {}` to postgres.js connection options.
4. **Defensive Zod schemas** - MCP Inspector and other clients may send empty strings for optional fields. Added `.catch()` on optional schema fields so empty/malformed values fall back to defaults instead of throwing validation errors.
5. **Restored z.enum() in tool schemas** - Initially moved enum validation to handlers for client compatibility, but reverted after confirming z.enum() works correctly with MCP SDK's Zod-to-JSON-Schema conversion.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed cosine distance SQL operator precedence**
- **Found during:** Task 1 (integration test suite)
- **Issue:** `1 - embedding <=> $vector` was parsed as `(1 - embedding) <=> $vector` instead of `1 - (embedding <=> $vector)`, producing incorrect similarity scores
- **Fix:** Added explicit parentheses around the `<=>` expression in the SQL query
- **Files modified:** src/repositories/memory-repository.ts
- **Verification:** Search tests pass with correct similarity ranking
- **Committed in:** b3c8c6d (part of Task 1 commit)

**2. [Rule 3 - Blocking] Added fileParallelism: false to vitest config**
- **Found during:** Task 1 (integration test suite)
- **Issue:** Parallel test files caused race conditions on shared Docker Postgres (truncation in one file corrupting another)
- **Fix:** Set `fileParallelism: false` in vitest.config.ts
- **Files modified:** vitest.config.ts
- **Verification:** All 27 tests pass reliably without race conditions
- **Committed in:** b3c8c6d (part of Task 1 commit)

**3. [Rule 1 - Bug] Fixed closeDb to reset singleton DB reference**
- **Found during:** Task 1 (integration test suite)
- **Issue:** closeDb() called `db.$client.end()` but didn't reset the module-level `db` variable, causing stale connection errors on subsequent test file runs
- **Fix:** Set `db = undefined` after ending the client connection
- **Files modified:** tests/helpers.ts (and corresponding src/db/index.ts)
- **Verification:** Test suite runs cleanly across all test files
- **Committed in:** b3c8c6d (part of Task 1 commit)

**4. [Rule 1 - Bug] Suppressed PostgreSQL NOTICE messages from stdout**
- **Found during:** Task 3 human verification (MCP Inspector testing)
- **Issue:** `CREATE EXTENSION IF NOT EXISTS pgvector` emitted NOTICE messages to stdout, corrupting JSON-RPC message framing and causing MCP Inspector connection failures
- **Fix:** Added `onnotice: () => {}` to postgres.js connection config in src/db/index.ts
- **Files modified:** src/db/index.ts
- **Verification:** MCP Inspector connects cleanly without parse errors
- **Committed in:** 0b43db0

**5. [Rule 2 - Missing Critical] Added .catch() on optional Zod schemas**
- **Found during:** Task 3 human verification (MCP Inspector testing)
- **Issue:** MCP Inspector sent empty strings for optional fields, causing Zod validation errors instead of graceful fallback
- **Fix:** Added `.catch()` to optional schema fields in tool definitions for defensive parsing
- **Files modified:** src/tools/memory-create.ts, memory-list.ts, memory-search.ts, memory-update.ts
- **Verification:** MCP Inspector can invoke all tools without validation errors
- **Committed in:** ef0a20f, d45a2d5

---

**Total deviations:** 5 auto-fixed (3 bugs, 1 blocking, 1 missing critical)
**Impact on plan:** All auto-fixes necessary for correctness and end-to-end functionality. No scope creep. Deviations 4-5 were discovered during human verification and fixed before approval.

## Issues Encountered

- MockEmbeddingProvider generates deterministic vectors based on content hash, which means search ranking tests needed careful content selection to produce distinguishable similarity scores. Resolved by using content with clear semantic groupings ("database migration patterns" vs "UI component styling").

## User Setup Required

None - no external service configuration required. Docker Postgres setup was completed in Plan 01.

## Known Stubs

None - all test data uses real service layer calls, all tools are fully wired to the database.

## Next Phase Readiness

- Phase 1 is complete: all 4 plans executed, all requirements verified
- Foundation ready for Phase 2 (Retrieval Quality and Session Lifecycle):
  - Database schema, migrations, and pgvector indexes in place
  - Memory service with CRUD + search fully tested
  - MCP server with 8 tools operational
  - Test infrastructure (helpers, Docker setup, vitest config) ready for Phase 2 tests
- No blockers for Phase 2

## Self-Check: PASSED

All 5 created files verified on disk. All 6 commit hashes verified in git log.

---
*Phase: 01-foundation-and-core-memory*
*Completed: 2026-03-23*
