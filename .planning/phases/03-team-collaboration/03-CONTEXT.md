# Phase 3: Team Collaboration - Context

**Gathered:** 2026-03-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Multiple users share project memories with provenance tracking, threaded discussions, and staleness management. Adds scope-based access control (project=shared, user=private), a comment system for team discussion on memories, team activity tracking via session enhancements and a new recent-activity tool, and input validation hardening across all existing tools.

</domain>

<decisions>
## Implementation Decisions

### Authentication Model

- **D-01:** Trust-the-client model — user_id is a per-call parameter with no server-side verification. Stdio transport is inherently single-user (OS process owner). Multi-user safety comes from each user running their own server instance.
- **D-02:** user_id stays per-call only — no config-level default. Consistent with project_id being per-call (Phase 1 D-33). Explicit over convenient.
- **D-03:** Trust is sufficient for v1 — no RLS enforcement. Provenance via author field satisfies TEAM-02 at the trust level. Real auth enforcement deferred to HTTP transport (v2).
- **D-04:** No client/agent tracking — no agent_id field. user_id and existing source field are sufficient.
- **D-05:** Validate user_id format — slug-like (lowercase alphanumeric + hyphens, max length). Prevents accidental garbage and keeps values consistent across the team.
- **D-06:** Apply slug validation to ALL tools retroactively (not just new Phase 3 tools). Minor breaking change but no external consumers.
- **D-07:** Validate new writes only — no migration of existing author values that may not conform to slug format.
- **D-08:** No users table — authors remain plain strings. No user registration or management. Any valid slug can write memories.
- **D-09:** project_id also gets slug validation across all tools for consistency.
- **D-10:** Reads stay anonymous for audit purposes (no read logging), but scope enforcement is applied to protect user-scoped memory privacy.

### Scope-Based Access Model

- **D-11:** Two-tier access model based on memory scope:
  - **Project memories** — fully shared: any team member can read, write, update, archive, comment, and verify.
  - **User memories** — fully private: only the original author can read, write, update, archive, comment, and verify.
- **D-12:** Clear permission error messages for unauthorized access: "Cannot modify user-scoped memory owned by another user."
- **D-13:** user_id required on ALL tools (reads and writes). Every call identifies who's asking. Enables scope enforcement on reads (memory_get, memory_list, memory_search, memory_list_stale).
- **D-14:** memory_search user_id required always — not just for scope='both'. Fully consistent model.
- **D-15:** Archiving follows same scope pattern: project=anyone can archive, user=owner only.
- **D-16:** memory_list_stale enforces user-scope privacy — only returns the requesting user's stale user-scoped memories.
- **D-17:** memory_get enforces scope — user-scoped memories return "not found" for non-owners.
- **D-18:** memory_list with scope=user only returns the requesting user's memories.

### Provenance Enhancements

- **D-19:** Add `verified_by` field alongside `verified_at` on memories. Records who confirmed the memory is still accurate.
- **D-20:** Anyone can verify project memories. User memories: only the owner can verify (consistent with full-private model).

### Multi-User Access

- **D-21:** Shared DB, stdio per user — each user runs their own MCP server instance pointing at the same Postgres database. No HTTP transport needed. Multi-user happens at the DB level.
- **D-22:** Documentation-only coordination for shared DB setup. No application code needed — this is an ops/config concern.
- **D-23:** Optimistic locking (Phase 1 D-30) sufficient for concurrent writes from multiple server instances. No additional concurrency controls.
- **D-24:** Postgres advisory locks during migration to prevent race conditions when multiple users update simultaneously.
- **D-25:** Connection pool hardcoded at 3 per instance (not configurable via env var). At expected team size, 3 * N users is well within RDS limits.
- **D-26:** No team info on startup banner. Keep existing banner as-is (version, DB status, embedding provider).
- **D-27:** Backwards-compatible migrations not a concern — small team, coordinated updates.

### Session Tracking & Team Activity

- **D-28:** Session tracking table — single row per (user_id, project_id) with `last_session_at`. UPSERT on each `memory_session_start` call. Minimal storage.
- **D-29:** Enhance `memory_session_start` response with `team_activity` in the `meta` section:
  ```
  meta: { count, timing, team_activity: { new_memories, updated_memories, commented_memories, since } }
  ```
- **D-30:** team_activity includes the user's own changes — a new session needs full context of what happened since last session, including your own past work.
- **D-31:** First session (no prior session recorded) falls back to last 7 days of activity. Hardcoded, not configurable.
- **D-32:** team_activity shows counts only — no contributor names/slugs. Agent calls `memory_list_recent` for that detail.

### New Tool: memory_list_recent

- **D-33:** New `memory_list_recent` tool for team activity awareness. Returns memories created or updated after a given ISO timestamp.
- **D-34:** Parameters: `project_id` (required), `user_id` (required), `since` (required, ISO timestamp), `limit` (optional, default 10), `exclude_self` (optional boolean, default false).
- **D-35:** Same scope-based privacy rules as all other tools. user_id required.
- **D-36:** Shows both created AND updated memories (checks created_at OR updated_at after `since`).
- **D-37:** `change_type` field on each result: `'created'`, `'updated'`, or `'commented'`. Distinguishes why the memory appeared.
- **D-38:** `exclude_self` option (default false) — when true, filters out memories authored by the requesting user_id. Useful for "what did teammates do?"
- **D-39:** Simple limit (default 10, configurable per-call). No cursor pagination. Recent changes are a snapshot.
- **D-40:** Follows standard envelope response: `{ data: MemoryWithRelevance[], meta: { count, timing } }`.

### Tool Inventory

- **D-41:** Phase 3 adds 2 new tools: `memory_comment`, `memory_list_recent`. Total: 11 tools.
- **D-42:** `memory_list_contributors` dropped — contributor info derivable from `memory_list_recent` results.
- **D-43:** All tools stay in `memory_` namespace.

### Comment Data Model

- **D-44:** Separate `comments` table with foreign key to memories. Each comment is its own row.
- **D-45:** Flat threading — all comments are direct replies to the memory. No `parent_comment_id`. No nesting.
- **D-46:** Append-only — once posted, a comment cannot be edited or deleted. Post a correction comment if needed.
- **D-47:** Basic fields only: `id` (nanoid), `memory_id` (FK), `author`, `content`, `created_at`. No metadata, no tags, no source.
- **D-48:** Comments inherit parent memory's scope-based access rules. No separate scope field on comments.
- **D-49:** ~1000 char soft content limit on comments. Warn but allow longer.
- **D-50:** Soft limit ~50 comments per memory. Warn but allow more.
- **D-51:** Nanoid for comment IDs — consistent with memory IDs.
- **D-52:** No denormalized `project_id` on comments — always join through parent memory for project context.

### Comment Behavior

- **D-53:** Adding a comment updates the parent memory's `updated_at` timestamp. Comments keep memories "alive" in recency ranking.
- **D-54:** Adding a comment does NOT bump the parent memory's `version` (optimistic locking counter). Version protects content edits, not comments.
- **D-55:** No comments on archived memories. Return error: "Cannot comment on an archived memory."
- **D-56:** No self-commenting — author cannot comment on their own project memory. Return helpful error: "Cannot comment on your own memory. Use memory_update to add context." This means user-scoped memories effectively cannot have comments (self-comment blocked + owner-only access = no eligible commenters).
- **D-57:** Comments do NOT affect the parent memory's embedding vector. No re-embedding on comment. Search finds memories by core content, not discussions.
- **D-58:** Keep comments in database when parent memory is archived. No cascade delete/archive.
- **D-59:** `comment_count` always computed via COUNT query — no denormalized counter column. Index on `comments.memory_id` makes this fast at expected scale.
- **D-60:** Accept LEFT JOIN cost on all memory queries for comment_count. Negligible at expected scale.

### Comment Display

- **D-61:** `comment_count` added to base `Memory` type. Present on ALL memory responses (search, list, get, etc.).
- **D-62:** `last_comment_at` timestamp added to memories table and base `Memory` type. Used for `change_type` detection: if `updated_at == last_comment_at`, change_type is `'commented'`.
- **D-63:** Full `comments` array only on `memory_get` response — NOT on the base Memory type. Other tools return comment_count but no comments array.
- **D-64:** Comments sorted oldest-first (chronological) in `memory_get` responses. Natural conversation reading order.

### Comment Tool: memory_comment

- **D-65:** Tool name: `memory_comment`.
- **D-66:** Minimal parameters: `memory_id` (required), `content` (required), `user_id` (required).
- **D-67:** Returns just the new comment object + `comment_count` in meta: `{ data: { id, author, content, created_at }, meta: { comment_count, timing } }`.
- **D-68:** No separate `memory_list_comments` tool. `memory_get` returns full comments — sufficient given ~50 soft cap.
- **D-69:** Tool description includes usage example and guidance: "Use to add context, follow-up, or discussion. For correcting the memory itself, use memory_update instead."
- **D-70:** Enforce scope-based access rules and self-comment block with descriptive errors.
- **D-71:** Reject empty or whitespace-only content.

### Capability Booleans

- **D-72:** `memory_get` response includes capability booleans: `can_comment`, `can_edit`, `can_archive`, `can_verify`. Computed from scope + ownership based on requesting user_id.
- **D-73:** Capability booleans on `memory_get` only — not on list/search/other tools. Keeps bulk responses lean.

### Cross-Cutting Changes

- **D-74:** Update ALL tool descriptions to reflect Phase 3 changes (user_id required on all, slug validation, scope enforcement, new capabilities).
- **D-75:** Apply non-empty content validation to `memory_create`, `memory_update`, and `memory_comment`. Reject empty/whitespace-only content.
- **D-76:** Keep server version at 0.1.0 — no version bump for pre-release software with no external consumers.

### Claude's Discretion

- Exact slug validation regex and max length for user_id and project_id
- Database indexes on comments table (memory_id index at minimum)
- Comment creation + parent updated_at update as single transaction
- Error handling details for edge cases beyond the specific ones discussed
- memory_list_recent sort order (presumably most recent activity first)
- Tool description exact wording and examples
- Test DB setup for new tables and access control tests

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Documentation
- `.planning/PROJECT.md` — Project vision, constraints, key decisions
- `.planning/REQUIREMENTS.md` — Full v1 requirements with traceability matrix (TEAM-01 through TEAM-07)
- `.planning/ROADMAP.md` — Phase breakdown with success criteria

### Prior Phase Context
- `.planning/phases/01-foundation-and-core-memory/01-CONTEXT.md` — All Phase 1 decisions (D-01 through D-68). Critical refs: D-02 (envelope format), D-10 (comment deferred to Phase 3), D-11 (memory_verify), D-12 (memory_list_stale), D-25 (author field), D-30 (optimistic locking), D-37 (app-level filtering, RLS deferred), D-38 (user_id on writes), D-49 (stdio only)
- `.planning/phases/02-retrieval-quality-and-session-lifecycle/02-CONTEXT.md` — Phase 2 decisions (D-01 through D-18). Critical refs: D-08 (cross-scope 'both'), D-09 (user_id for cross-scope), D-10 (single SQL OR), D-12 (memory_session_start)

### Tech Stack
- `CLAUDE.md` §Technology Stack — Stack versions, Drizzle ORM patterns, pgvector config

### Existing Implementation
- `src/db/schema.ts` — Current DB schema (memories, projects tables). Phase 3 adds comments table, new columns on memories, session tracking table.
- `src/types/memory.ts` — Memory, MemoryCreate, MemoryUpdate, MemoryWithRelevance types. Phase 3 adds comment_count, last_comment_at to Memory, new Comment type, capability booleans on get response.
- `src/repositories/types.ts` — Repository interfaces. Phase 3 adds CommentRepository, extends MemoryRepository with scope enforcement.
- `src/repositories/memory-repository.ts` — Current implementation. Phase 3 adds user_id-based scope checks, LEFT JOIN for comment_count.
- `src/services/memory-service.ts` — Service layer. Phase 3 adds access control logic, comment service methods.
- `src/tools/index.ts` — Tool registration. Phase 3 adds memory_comment, memory_list_recent.
- `src/tools/memory-search.ts` — Search tool. Phase 3 makes user_id required.
- `src/tools/memory-get.ts` — Get tool. Phase 3 adds user_id, scope enforcement, comments array, capability booleans.
- `src/tools/memory-session-start.ts` — Session start tool. Phase 3 adds team_activity to meta, session tracking UPSERT.
- `src/config.ts` — Server config. Phase 3 adds pool size (hardcoded 3).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `toolResponse` and `withErrorHandling` in `src/tools/tool-utils.ts` — tool utilities for new memory_comment and memory_list_recent tools
- `memoryColumns` in memory-repository.ts — explicit column selection, extend with comment_count subquery
- Envelope response structure — consistent `{ data, meta }` pattern across all tools
- `registerMemory*` pattern — follow for new tool registration
- Zod schema validation with `.catch()` for defensive MCP client handling
- `generateId` from `src/utils/id.ts` — nanoid generation for comment IDs

### Established Patterns
- App-layer filtering after DB query (Phase 1 D-42 min_similarity, Phase 2 composite scoring) — access control checks follow same pattern
- Repository interface abstraction — new CommentRepository follows MemoryRepository pattern
- Tool registration pattern — `registerMemoryComment`, `registerMemoryListRecent` follow existing convention
- All logging to stderr via `logger` utility
- Integration tests against real Docker Postgres (Phase 1 D-61)

### Integration Points
- `src/tools/index.ts` — register memory_comment and memory_list_recent
- `src/db/schema.ts` — add comments table, session_tracking table, new columns on memories (last_comment_at, verified_by)
- `src/types/memory.ts` — extend Memory type with comment_count, last_comment_at; add Comment type
- `src/repositories/types.ts` — add CommentRepository interface, extend MemoryRepository
- `src/services/memory-service.ts` — add comment methods, access control, session tracking
- `src/config.ts` — add pool size setting
- All existing tool files — add user_id parameter, slug validation, update descriptions

</code_context>

<specifics>
## Specific Ideas

- User explicitly chose trust-the-client over any auth infrastructure — keeping v1 simple with auth deferred to HTTP transport
- User chose scope-based access (project=shared, user=private) over author-based ownership — cleaner model where scope determines everything
- User dropped memory_list_contributors — derivable from memory_list_recent, one less tool to maintain
- User wants self-commenting blocked — comments are exclusively a cross-user collaboration tool. Authors use memory_update for their own context.
- User wants team_activity to include the user's own changes — a new session needs full context reconstruction, not just what others did
- User chose to add capability booleans (can_comment, can_edit, can_archive, can_verify) to memory_get — agents should know what actions are available without trial-and-error
- User prefers hardcoded values over config knobs for new settings (pool size=3, first session fallback=7 days) — less configuration surface
- User chose append-only comments — audit trail preservation is more important than edit convenience

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

All scope boundaries maintained:
- HTTP transport / real authentication → v2 / future phase
- RLS database enforcement → deferred with HTTP transport
- Users table / user management → not needed for trust-the-client model
- Session history / analytics → Phase 4 (Agent Autonomy) may revisit
- Comment search / semantic matching → not planned
- Nested comment threading → rejected in favor of flat

</deferred>

---

*Phase: 03-team-collaboration*
*Context gathered: 2026-03-23*
