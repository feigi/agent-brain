---
phase: 03-team-collaboration
plan: 03
subsystem: comments-and-activity
tags:
  [comments, session-tracking, team-activity, memory-get-enhancement, mcp-tools]

# Dependency graph
requires:
  - phase: 03-team-collaboration
    plan: 01
    provides: comments table, sessionTracking table, last_comment_at column, Comment/MemoryGetResponse/MemoryWithChangeType types, CommentRepository/SessionTrackingRepository interfaces
  - phase: 03-team-collaboration
    plan: 02
    provides: canAccess/assertCanModify helpers, slugSchema/contentSchema validators, access control in service

provides:
  - DrizzleCommentRepository: transactional create (parent timestamp update without version bump), findByMemoryId (oldest-first), countByMemoryId
  - DrizzleSessionTrackingRepository: UPSERT returning previous last_session_at (null on first session)
  - MemoryService.addComment(): archived/self-comment/user-scope checks, soft limits (1000 chars, 50 comments)
  - MemoryService.getWithComments(): comments array + capability booleans (can_comment, can_edit, can_archive, can_verify)
  - MemoryService.listRecentActivity(): change_type detection (created/updated/commented) via timestamp comparison
  - MemoryService.sessionStart() enhanced: session tracking (D-28) + team_activity counts in meta (D-29)
  - memory_comment MCP tool: append-only, cannot self-comment, cannot comment on archived
  - memory_list_recent MCP tool: activity since timestamp, change_type, exclude_self option
  - memory_get enhanced: returns MemoryGetResponse with comments + capabilities
  - Total registered tools: 11

affects: [03-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Transaction pattern: comment create wraps INSERT + parent timestamp UPDATE in single tx (no version bump)"
    - "Session UPSERT: select-then-upsert to capture previous timestamp -- onConflictDoUpdate targeting composite key"
    - "Optional repository injection: commentRepo?/sessionRepo? optional in MemoryService constructor for backward compat"
    - "change_type detection: created_at >= since => created; updated_at == last_comment_at => commented; else updated"
    - "Capability booleans: can_comment = project scope AND not owner (D-56); others based on canAccess()"

key-files:
  created:
    - src/repositories/comment-repository.ts
    - src/repositories/session-repository.ts
    - src/tools/memory-comment.ts
    - src/tools/memory-list-recent.ts
  modified:
    - src/services/memory-service.ts
    - src/tools/memory-get.ts
    - src/tools/index.ts
    - src/server.ts

key-decisions:
  - "Optional commentRepo/sessionRepo in MemoryService constructor: preserves backward compatibility for tests that construct MemoryService without new repos"
  - "Self-comment block applies to both project and user-scoped memories (D-56): user-scoped memories first check owner access, then hit self-comment block"
  - "getChangeType uses timestamp equality (updated_at == last_comment_at) to detect commented state -- accurate because comment create sets both to now() atomically"
  - "sessionStart now calls projectRepo.findOrCreate() explicitly before session tracking -- the prior implementation relied on the downstream search/list path to trigger it"

# Metrics
duration: 3min
completed: 2026-03-23
---

# Phase 3 Plan 03: Comment System, Activity Feed, and Enhanced memory_get Summary

**Comment system with transactional repositories, two new MCP tools (memory_comment + memory_list_recent), session tracking with team_activity meta, and memory_get enhanced to return comments array and capability booleans**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-23T20:27:48Z
- **Completed:** 2026-03-23T20:30:57Z
- **Tasks:** 2
- **Files created:** 4
- **Files modified:** 4

## Accomplishments

- `DrizzleCommentRepository` created: `create()` wraps comment INSERT + parent `updated_at`/`last_comment_at` update in a single transaction without touching `version`; `findByMemoryId()` returns oldest-first; `countByMemoryId()` uses `COUNT(*)::int`
- `DrizzleSessionTrackingRepository` created: `upsert()` reads previous `last_session_at` then does `onConflictDoUpdate`, returns the old value (or null for first session)
- `MemoryService.addComment()` added: validates not archived (D-55), checks scope rules, blocks self-comment (D-56), applies soft limits with warnings (1000 chars, 50 comments), returns `Envelope<Comment>` with `comment_count` in meta
- `MemoryService.getWithComments()` added: full comments array (oldest-first), capability booleans `can_comment`/`can_edit`/`can_archive`/`can_verify` for the requesting user
- `MemoryService.listRecentActivity()` added: delegates to `memoryRepo.findRecentActivity()`, maps each result to `change_type` via timestamp comparison
- `MemoryService.sessionStart()` enhanced: now calls `sessionRepo.upsert()` for D-28 session tracking, computes `since` from previous session (or 7-day fallback), adds `team_activity` counts to meta (D-29)
- `memory_comment` MCP tool registered: uses `contentSchema` for content, `slugSchema` for `user_id`
- `memory_list_recent` MCP tool registered: `since: z.string().datetime()`, `limit`, `exclude_self: z.boolean().default(false)`
- `memory_get` updated to call `getWithComments()` -- returns full `MemoryGetResponse` with comments + capabilities
- `tools/index.ts` now registers 11 tools (added `memory_comment` + `memory_list_recent`)
- `server.ts` updated to wire `DrizzleCommentRepository` and `DrizzleSessionTrackingRepository` into `MemoryService`
- All 52 existing tests pass without modification

## Task Commits

1. **Task 1: Comment and session repositories** - `a09a617` (feat)
2. **Task 2: Service methods, new tools, memory_get enhancement, server wiring** - `8be79db` (feat)

## Files Created/Modified

- `src/repositories/comment-repository.ts` - `DrizzleCommentRepository`: create (tx), findByMemoryId (oldest-first), countByMemoryId
- `src/repositories/session-repository.ts` - `DrizzleSessionTrackingRepository`: upsert with previous timestamp capture
- `src/services/memory-service.ts` - addComment, getWithComments, listRecentActivity, getChangeType, sessionStart enhanced
- `src/tools/memory-comment.ts` - memory_comment tool with contentSchema + slugSchema validation
- `src/tools/memory-list-recent.ts` - memory_list_recent tool with since/limit/exclude_self
- `src/tools/memory-get.ts` - calls getWithComments instead of get
- `src/tools/index.ts` - registers 11 tools (was 9)
- `src/server.ts` - wires commentRepo + sessionRepo into MemoryService constructor

## Decisions Made

- Optional `commentRepo?`/`sessionRepo?` in `MemoryService` constructor preserves backward compatibility with test setups that don't need the new repos
- Self-comment block applies uniformly to user-scoped memories: owner access check first (D-17), then self-comment block triggers `ValidationError` (so user-scoped memories are effectively uncommentable)
- `getChangeType` uses `updated_at === last_comment_at` equality to detect comment-driven updates -- this works because comment creation sets both timestamps to `now()` atomically in a transaction
- `sessionStart` now calls `projectRepo.findOrCreate()` at the top before session tracking -- this was already happening via downstream search paths but is now explicit for correctness

## Deviations from Plan

None -- plan executed exactly as written. Both repositories, all service methods, both tools, memory-get enhancement, and server wiring implemented per spec. All 52 existing tests pass without modification.

## Known Stubs

None -- all comment functionality is fully wired. Comment repository is real, service methods are complete, tools are registered. Session tracking is wired into sessionStart with team_activity counts populated via `memoryRepo.countTeamActivity`.

## Self-Check: PASSED

- FOUND: src/repositories/comment-repository.ts
- FOUND: src/repositories/session-repository.ts
- FOUND: src/tools/memory-comment.ts
- FOUND: src/tools/memory-list-recent.ts
- FOUND: src/services/memory-service.ts (addComment, getWithComments, listRecentActivity)
- FOUND: src/tools/memory-get.ts (calls getWithComments)
- FOUND: src/tools/index.ts (11 registrations)
- FOUND: src/server.ts (DrizzleCommentRepository + DrizzleSessionTrackingRepository wired)
- FOUND: commit a09a617 (Task 1)
- FOUND: commit 8be79db (Task 2)
- All 52 tests pass

---

_Phase: 03-team-collaboration_
_Completed: 2026-03-23_
