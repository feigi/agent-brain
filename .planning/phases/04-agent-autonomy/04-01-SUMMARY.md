---
phase: 04-agent-autonomy
plan: 01
subsystem: session-lifecycle
tags: [sessions, budget-tracking, schema, types, repository]
dependency_graph:
  requires: []
  provides:
    [sessions-table, session-repository, session-id-in-meta, budget-config]
  affects: [memory-service, server, envelope-type, memory-types]
tech_stack:
  added: []
  patterns: [atomic-budget-increment, optional-constructor-injection]
key_files:
  created:
    - src/repositories/session-repository.ts (DrizzleSessionRepository class)
    - drizzle/0002_worthless_human_cannonball.sql (sessions table migration)
  modified:
    - src/db/schema.ts (sessions table added)
    - src/config.ts (writeBudgetPerSession, duplicateThreshold added)
    - src/types/envelope.ts (session_id and budget in meta)
    - src/types/memory.ts (CreateSkipResult type added)
    - src/repositories/types.ts (SessionRepository interface added)
    - src/services/memory-service.ts (6th constructor param, session_id generation)
    - src/server.ts (DrizzleSessionRepository wired up)
decisions:
  - "sessions table is separate from session_tracking -- sessions tracks lifecycle/budget, session_tracking tracks team activity timestamps"
  - "Atomic budget increment: UPDATE WHERE budget_used < limit RETURNING -- prevents race conditions without application-level locking"
  - "sessionLifecycleRepo optional (6th param) in MemoryService constructor -- preserves backward compatibility for existing tests"
  - "session_id generated with generateId() (nanoid 21-char) then persisted before memory search -- ensures session_id is always valid if budget tracking is used"
metrics:
  duration: 8min
  completed_date: "2026-03-23"
  tasks_completed: 2
  files_modified: 8
---

# Phase 4 Plan 1: Session Lifecycle Foundation Summary

Session lifecycle infrastructure: sessions table, budget config, type extensions, atomic budget repository, and session_id generation in memory_session_start.

## What Was Built

**Task 1 - Schema, config, and type extensions (commit 3325b84):**

- `sessions` table in `src/db/schema.ts`: id (nanoid PK), user_id, project_id (FK to projects), budget_used (integer default 0), created_at
- `sessionTracking` table preserved -- these are separate concerns (session_tracking = team activity timestamps; sessions = lifecycle/budget)
- `src/config.ts` extended with `writeBudgetPerSession` (default 10, env var `WRITE_BUDGET_PER_SESSION`) and `duplicateThreshold` (default 0.90, env var `DUPLICATE_THRESHOLD`)
- `src/types/envelope.ts` Envelope meta extended with `session_id?: string` and `budget?: { used, limit, exceeded }`
- `src/types/memory.ts` new `CreateSkipResult` discriminated union with `reason: 'budget_exceeded' | 'duplicate'`
- `src/repositories/types.ts` new `SessionRepository` interface with `createSession`, `getBudget`, `incrementBudgetUsed`, `findById`

**Task 2 - Repository, service, server wiring, and migration (commit 12649c5):**

- `DrizzleSessionRepository` class added to `src/repositories/session-repository.ts` (existing `DrizzleSessionTrackingRepository` preserved)
- Atomic budget increment: `UPDATE sessions SET budget_used = budget_used + 1 WHERE id = ? AND budget_used < limit RETURNING budget_used` -- no application-level locking needed
- `MemoryService` constructor extended with optional 6th param `sessionLifecycleRepo?: SessionRepository`
- `sessionStart()` now generates a `sessionId = generateId()`, calls `createSession()`, and returns `session_id` in envelope meta
- `src/server.ts` imports `DrizzleSessionRepository` and passes it as `sessionLifecycleRepo` to `MemoryService`
- Drizzle migration `0002_worthless_human_cannonball.sql` generated and applied -- creates `sessions` table with FK constraint

## Decisions Made

1. **sessions vs session_tracking separation**: The existing `session_tracking` table tracks "last seen at" timestamps for team activity detection. The new `sessions` table tracks the lifecycle of each agent session for budget enforcement. These are distinct concerns with different access patterns.

2. **Atomic budget increment**: Used `UPDATE WHERE budget_used < limit RETURNING` rather than a read-then-write pattern. This eliminates TOCTOU race conditions when multiple concurrent writes happen within the same session.

3. **Optional 6th constructor param**: `MemoryService` previously had 5 params; adding `sessionLifecycleRepo` as optional 6th preserves backward compatibility for all existing unit and integration tests that construct `MemoryService` without the new repo.

4. **session_id generated before search**: The session_id is generated and persisted at the start of `sessionStart()`, before the memory search. This ensures the session record exists when Plans 03/04 attempt to validate budget before writing.

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

Files verified:

- FOUND: src/db/schema.ts (contains sessions and sessionTracking)
- FOUND: src/config.ts (contains writeBudgetPerSession)
- FOUND: src/types/envelope.ts (contains session_id)
- FOUND: src/types/memory.ts (contains CreateSkipResult)
- FOUND: src/repositories/types.ts (contains SessionRepository and SessionTrackingRepository)
- FOUND: src/repositories/session-repository.ts (contains DrizzleSessionRepository and DrizzleSessionTrackingRepository)
- FOUND: src/services/memory-service.ts (contains sessionId, createSession, session_id in meta)
- FOUND: src/server.ts (contains DrizzleSessionRepository, sessionLifecycleRepo)
- FOUND: drizzle/0002_worthless_human_cannonball.sql (contains CREATE TABLE "sessions")

Commits verified:

- FOUND: 3325b84 (Task 1)
- FOUND: 12649c5 (Task 2)

Tests: 107/107 passing
