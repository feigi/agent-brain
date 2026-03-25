# Phase 3: Team Collaboration - Research

**Researched:** 2026-03-23
**Domain:** Multi-user access control, comment system, session tracking, input validation
**Confidence:** HIGH

## Summary

Phase 3 transforms a single-user memory system into a multi-user collaborative platform. The core additions are: (1) scope-based access control where project memories are shared and user memories are private, (2) a flat comment threading system for cross-user discussion on memories, (3) session tracking with team activity awareness, and (4) slug validation hardening across all existing tools.

The existing codebase is well-structured for these additions. The repository abstraction pattern, service layer, and tool registration conventions established in Phases 1-2 provide clear extension points. No new dependencies are needed -- all changes use the existing Drizzle ORM, Zod, and MCP SDK stack. The primary technical challenges are: adding `comment_count` as a computed field to all memory queries without breaking existing interfaces, implementing access control checks at the service layer without cluttering the repository, and retrofitting `user_id` as a required parameter on all 9 existing tools.

**Primary recommendation:** Implement in layers -- database schema changes first (new tables + columns + migration), then access control infrastructure (validation + authorization), then new tools (comment + list_recent), then existing tool retrofits. Keep access control in the service layer, not the repository, consistent with the established app-layer filtering pattern from Phases 1-2.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Trust-the-client model -- user_id is a per-call parameter with no server-side verification. Stdio transport is inherently single-user (OS process owner). Multi-user safety comes from each user running their own server instance.
- **D-02:** user_id stays per-call only -- no config-level default. Consistent with project_id being per-call (Phase 1 D-33). Explicit over convenient.
- **D-03:** Trust is sufficient for v1 -- no RLS enforcement. Provenance via author field satisfies TEAM-02 at the trust level. Real auth enforcement deferred to HTTP transport (v2).
- **D-04:** No client/agent tracking -- no agent_id field. user_id and existing source field are sufficient.
- **D-05:** Validate user_id format -- slug-like (lowercase alphanumeric + hyphens, max length). Prevents accidental garbage and keeps values consistent across the team.
- **D-06:** Apply slug validation to ALL tools retroactively (not just new Phase 3 tools). Minor breaking change but no external consumers.
- **D-07:** Validate new writes only -- no migration of existing author values that may not conform to slug format.
- **D-08:** No users table -- authors remain plain strings. No user registration or management. Any valid slug can write memories.
- **D-09:** project_id also gets slug validation across all tools for consistency.
- **D-10:** Reads stay anonymous for audit purposes (no read logging), but scope enforcement is applied to protect user-scoped memory privacy.
- **D-11:** Two-tier access model based on memory scope: Project memories = fully shared. User memories = fully private (only original author can read/write/update/archive/comment/verify).
- **D-12:** Clear permission error messages for unauthorized access: "Cannot modify user-scoped memory owned by another user."
- **D-13:** user_id required on ALL tools (reads and writes). Every call identifies who's asking. Enables scope enforcement on reads.
- **D-14:** memory_search user_id required always -- not just for scope='both'. Fully consistent model.
- **D-15:** Archiving follows same scope pattern: project=anyone can archive, user=owner only.
- **D-16:** memory_list_stale enforces user-scope privacy -- only returns the requesting user's stale user-scoped memories.
- **D-17:** memory_get enforces scope -- user-scoped memories return "not found" for non-owners.
- **D-18:** memory_list with scope=user only returns the requesting user's memories.
- **D-19:** Add `verified_by` field alongside `verified_at` on memories. Records who confirmed the memory is still accurate.
- **D-20:** Anyone can verify project memories. User memories: only the owner can verify (consistent with full-private model).
- **D-21:** Shared DB, stdio per user -- each user runs their own MCP server instance pointing at the same Postgres database.
- **D-22:** Documentation-only coordination for shared DB setup.
- **D-23:** Optimistic locking (Phase 1 D-30) sufficient for concurrent writes.
- **D-24:** Postgres advisory locks during migration to prevent race conditions.
- **D-25:** Connection pool hardcoded at 3 per instance.
- **D-26:** No team info on startup banner.
- **D-27:** Backwards-compatible migrations not a concern.
- **D-28:** Session tracking table -- single row per (user_id, project_id) with `last_session_at`. UPSERT on each `memory_session_start` call.
- **D-29:** Enhance `memory_session_start` response with `team_activity` in the `meta` section.
- **D-30:** team_activity includes the user's own changes.
- **D-31:** First session (no prior session recorded) falls back to last 7 days of activity. Hardcoded.
- **D-32:** team_activity shows counts only -- no contributor names/slugs.
- **D-33:** New `memory_list_recent` tool. Returns memories created or updated after a given ISO timestamp.
- **D-34:** Parameters: `project_id` (required), `user_id` (required), `since` (required, ISO timestamp), `limit` (optional, default 10), `exclude_self` (optional boolean, default false).
- **D-35:** Same scope-based privacy rules as all other tools.
- **D-36:** Shows both created AND updated memories (checks created_at OR updated_at after `since`).
- **D-37:** `change_type` field on each result: `'created'`, `'updated'`, or `'commented'`.
- **D-38:** `exclude_self` option (default false) -- when true, filters out memories authored by requesting user_id.
- **D-39:** Simple limit (default 10, configurable per-call). No cursor pagination.
- **D-40:** Follows standard envelope response.
- **D-41:** Phase 3 adds 2 new tools: `memory_comment`, `memory_list_recent`. Total: 11 tools.
- **D-42:** `memory_list_contributors` dropped.
- **D-43:** All tools stay in `memory_` namespace.
- **D-44:** Separate `comments` table with foreign key to memories.
- **D-45:** Flat threading -- all comments are direct replies to the memory. No nesting.
- **D-46:** Append-only -- once posted, a comment cannot be edited or deleted.
- **D-47:** Basic fields only: `id` (nanoid), `memory_id` (FK), `author`, `content`, `created_at`.
- **D-48:** Comments inherit parent memory's scope-based access rules.
- **D-49:** ~1000 char soft content limit on comments. Warn but allow longer.
- **D-50:** Soft limit ~50 comments per memory. Warn but allow more.
- **D-51:** Nanoid for comment IDs.
- **D-52:** No denormalized `project_id` on comments -- always join through parent memory.
- **D-53:** Adding a comment updates the parent memory's `updated_at` timestamp.
- **D-54:** Adding a comment does NOT bump the parent memory's `version`.
- **D-55:** No comments on archived memories.
- **D-56:** No self-commenting -- author cannot comment on their own project memory. User-scoped memories effectively cannot have comments.
- **D-57:** Comments do NOT affect the parent memory's embedding vector.
- **D-58:** Keep comments in database when parent memory is archived. No cascade delete/archive.
- **D-59:** `comment_count` always computed via COUNT query -- no denormalized counter column.
- **D-60:** Accept LEFT JOIN cost on all memory queries for comment_count.
- **D-61:** `comment_count` added to base `Memory` type. Present on ALL memory responses.
- **D-62:** `last_comment_at` timestamp added to memories table and base `Memory` type. Used for `change_type` detection.
- **D-63:** Full `comments` array only on `memory_get` response.
- **D-64:** Comments sorted oldest-first (chronological) in `memory_get` responses.
- **D-65:** Tool name: `memory_comment`.
- **D-66:** Minimal parameters: `memory_id` (required), `content` (required), `user_id` (required).
- **D-67:** Returns just the new comment object + `comment_count` in meta.
- **D-68:** No separate `memory_list_comments` tool.
- **D-69:** Tool description includes usage example and guidance.
- **D-70:** Enforce scope-based access rules and self-comment block with descriptive errors.
- **D-71:** Reject empty or whitespace-only content.
- **D-72:** `memory_get` response includes capability booleans: `can_comment`, `can_edit`, `can_archive`, `can_verify`.
- **D-73:** Capability booleans on `memory_get` only.
- **D-74:** Update ALL tool descriptions to reflect Phase 3 changes.
- **D-75:** Apply non-empty content validation to `memory_create`, `memory_update`, and `memory_comment`.
- **D-76:** Keep server version at 0.1.0.

### Claude's Discretion

- Exact slug validation regex and max length for user_id and project_id
- Database indexes on comments table (memory_id index at minimum)
- Comment creation + parent updated_at update as single transaction
- Error handling details for edge cases beyond the specific ones discussed
- memory_list_recent sort order (presumably most recent activity first)
- Tool description exact wording and examples
- Test DB setup for new tables and access control tests

### Deferred Ideas (OUT OF SCOPE)

None -- discussion stayed within phase scope. All scope boundaries maintained:

- HTTP transport / real authentication -> v2 / future phase
- RLS database enforcement -> deferred with HTTP transport
- Users table / user management -> not needed for trust-the-client model
- Session history / analytics -> Phase 4 (Agent Autonomy) may revisit
- Comment search / semantic matching -> not planned
- Nested comment threading -> rejected in favor of flat
  </user_constraints>

<phase_requirements>

## Phase Requirements

| ID      | Description                                                                      | Research Support                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| TEAM-01 | Multiple users can read and write to shared project memories                     | Shared DB with per-user stdio instances (D-21). Scope-based access model (D-11): project=shared, user=private. All tools require user_id (D-13). |
| TEAM-02 | Authentication identifies which user/agent is writing memories                   | Trust-the-client model (D-01): user_id is per-call parameter with slug validation (D-05). Maps to `author` field in service layer.               |
| TEAM-03 | Each memory records its author (provenance tracking)                             | Already implemented in Phase 1 (author field on memories). Phase 3 adds `verified_by` (D-19) and comment author tracking (D-47).                 |
| TEAM-04 | User can append a comment to an existing memory (threaded notes)                 | New `comments` table (D-44) with flat threading (D-45). New `memory_comment` tool (D-65). Append-only (D-46).                                    |
| TEAM-05 | Threaded comments preserve original memory content and add context               | Comments are separate table rows (D-44). No edits to comments (D-46). No re-embedding on comment (D-57). Parent version not bumped (D-54).       |
| TEAM-06 | User can verify a memory is still accurate                                       | Already partially implemented (Phase 1 verify tool). Phase 3 adds `verified_by` field (D-19) and scope enforcement (D-20).                       |
| TEAM-07 | Agent can list memories that haven't been verified within configurable threshold | Already implemented (Phase 1 list_stale tool). Phase 3 adds user_id requirement (D-13) and scope enforcement on results (D-16).                  |

</phase_requirements>

## Standard Stack

No new dependencies needed. Phase 3 uses the established stack entirely.

### Core (already installed)

| Library     | Version | Purpose             | Phase 3 Usage                                                                                                                                              |
| ----------- | ------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| drizzle-orm | 0.45.1  | ORM + query builder | New tables (comments, session_tracking), `db.$count()` for comment_count, `db.transaction()` for comment creation, `onConflictDoUpdate` for session UPSERT |
| drizzle-kit | 0.31.10 | Migrations          | Generate migration for new tables + columns                                                                                                                |
| zod         | 4.3.6   | Schema validation   | `.regex()` for slug validation, `.trim()` + `.min(1)` for content validation                                                                               |
| nanoid      | 5.x     | ID generation       | Comment IDs via existing `generateId()`                                                                                                                    |
| vitest      | 4.1.0   | Testing             | Access control tests, comment tests, validation tests                                                                                                      |

### No New Packages Required

Phase 3 is purely application-level logic using the existing stack. No install commands needed.

## Architecture Patterns

### New Database Schema (comments table)

```typescript
// src/db/schema.ts - additions
export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(), // nanoid (D-51)
    memory_id: text("memory_id")
      .notNull()
      .references(() => memories.id), // FK to memories (D-44)
    author: text("author").notNull(), // who commented (D-47)
    content: text("content").notNull(), // comment text (D-47)
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(), // D-47
  },
  (table) => [
    index("comments_memory_id_idx").on(table.memory_id), // Required for COUNT queries
    index("comments_created_at_idx").on(table.created_at), // For ordering
  ],
);
```

### New Database Schema (session_tracking table)

```typescript
// src/db/schema.ts - additions
export const sessionTracking = pgTable(
  "session_tracking",
  {
    user_id: text("user_id").notNull(),
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id),
    last_session_at: timestamp("last_session_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Composite primary key on (user_id, project_id) for UPSERT target
    // Use primaryKey() or unique index
  ],
);
```

### New Columns on memories table

```typescript
// Added to memories definition in schema.ts:
verified_by: text("verified_by"),                                     // D-19
last_comment_at: timestamp("last_comment_at", { withTimezone: true }), // D-62
```

### Pattern 1: Computed comment_count via db.$count()

**What:** Add `comment_count` as a computed field to all memory queries using Drizzle's `$count()` correlated subquery.
**When to use:** Every memory query (search, list, get, listStale, listRecent).
**Confidence:** HIGH -- verified `$count` exists in installed drizzle-orm@0.45.1 pg-core types.

```typescript
// Source: https://orm.drizzle.team/docs/query-utils
// Extend memoryColumns to include comment_count:
const memoryColumnsWithCount = {
  ...memoryColumns,
  // Add new columns:
  verified_by: memories.verified_by,
  last_comment_at: memories.last_comment_at,
  // Computed field:
  comment_count: db.$count(comments, eq(comments.memory_id, memories.id)),
};
```

**Critical note:** `db.$count()` returns a number but PostgreSQL count returns bigint which postgres.js interprets as string. Cast with `Number()` or use `sql<number>` pattern. The `$count` utility handles this internally -- verify in integration tests.

**Alternative approach if $count causes issues:** Use a raw SQL subquery:

```typescript
comment_count: sql<number>`(SELECT COUNT(*)::int FROM comments WHERE comments.memory_id = memories.id)`,
```

### Pattern 2: Access Control at Service Layer

**What:** All authorization checks happen in the service layer, not the repository. Repository remains scope-unaware beyond query filtering.
**When to use:** Every service method that reads or writes memories.
**Why:** Consistent with established app-layer filtering pattern (Phase 1 D-42, Phase 2 composite scoring).

```typescript
// src/services/memory-service.ts

// Helper: check if user can access a memory
private canAccess(memory: Memory, userId: string): boolean {
  if (memory.scope === 'project') return true;  // D-11: project = shared
  return memory.author === userId;               // D-11: user = owner only
}

// Helper: check if user can modify a memory
private canModify(memory: Memory, userId: string): boolean {
  return this.canAccess(memory, userId);  // Same rule for read and write
}
```

### Pattern 3: Slug Validation with Zod

**What:** Reusable slug validator applied to user_id and project_id across all tools.
**Discretion area:** Regex and max length.

```typescript
// src/utils/validation.ts
import { z } from "zod";

// Slug: lowercase alphanumeric + hyphens, 1-64 chars, no leading/trailing hyphens
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 64;

export const slugSchema = z
  .string()
  .min(1, "Must not be empty")
  .max(SLUG_MAX_LENGTH, `Must be ${SLUG_MAX_LENGTH} characters or fewer`)
  .regex(
    SLUG_REGEX,
    "Must be lowercase alphanumeric with hyphens (e.g., 'my-project')",
  );

// Reusable non-empty content validator
export const contentSchema = z
  .string()
  .trim()
  .min(1, "Content must not be empty or whitespace-only");
```

### Pattern 4: Transaction for Comment + Parent Update

**What:** Comment creation and parent `updated_at`/`last_comment_at` update in a single transaction.
**Confidence:** HIGH -- verified Drizzle transaction API with postgres.js.

```typescript
// Source: https://orm.drizzle.team/docs/transactions
await this.db.transaction(async (tx) => {
  // Insert the comment
  await tx.insert(comments).values({ ... });
  // Update parent memory's timestamps (D-53: updated_at, D-62: last_comment_at)
  // Note: do NOT bump version (D-54)
  await tx.update(memories)
    .set({
      updated_at: sql`now()`,
      last_comment_at: sql`now()`,
    })
    .where(eq(memories.id, memoryId));
});
```

### Pattern 5: Session Tracking UPSERT

**What:** Record last session timestamp per (user_id, project_id) using Drizzle's `onConflictDoUpdate`.
**Confidence:** HIGH -- verified Drizzle UPSERT API.

```typescript
// Source: https://orm.drizzle.team/docs/insert (onConflictDoUpdate section)
await this.db
  .insert(sessionTracking)
  .values({
    user_id: userId,
    project_id: projectId,
    last_session_at: sql`now()`,
  })
  .onConflictDoUpdate({
    target: [sessionTracking.user_id, sessionTracking.project_id],
    set: { last_session_at: sql`now()` },
  });
```

### Pattern 6: Capability Booleans for memory_get

**What:** Compute `can_comment`, `can_edit`, `can_archive`, `can_verify` based on scope + ownership.
**When to use:** Only on `memory_get` response (D-73).

```typescript
// Compute after fetching memory, before returning response
function computeCapabilities(memory: Memory, userId: string) {
  const isOwner = memory.author === userId;
  const isProject = memory.scope === "project";
  const canAccess = isProject || isOwner;

  return {
    can_edit: canAccess,
    can_archive: canAccess,
    can_verify: canAccess, // D-20: project=anyone, user=owner only
    can_comment: isProject && !isOwner, // D-56: no self-comment; user-scoped can't have comments
  };
}
```

### Pattern 7: change_type Detection for memory_list_recent

**What:** Determine whether a memory appeared in recent results due to creation, update, or comment.
**When to use:** `memory_list_recent` tool (D-37).

```typescript
function getChangeType(
  memory: Memory & { last_comment_at: Date | null },
  since: Date,
): "created" | "updated" | "commented" {
  if (memory.created_at >= since) return "created";
  // D-62: if updated_at matches last_comment_at, the update was from a comment
  if (
    memory.last_comment_at &&
    memory.updated_at.getTime() === memory.last_comment_at.getTime()
  )
    return "commented";
  return "updated";
}
```

### Recommended Project Structure (additions only)

```
src/
  db/
    schema.ts               # +comments table, +session_tracking table, +new memory columns
  types/
    memory.ts               # +comment_count, +last_comment_at, +verified_by on Memory
                            # +Comment interface, +MemoryGetResponse with capabilities
  utils/
    validation.ts           # NEW: slugSchema, contentSchema
    errors.ts               # +AuthorizationError
  repositories/
    types.ts                # +CommentRepository interface, +SessionTrackingRepository
    memory-repository.ts    # +comment_count in queries, +scope-filtered queries
    comment-repository.ts   # NEW: comment CRUD
    session-repository.ts   # NEW: session UPSERT + lookup
  services/
    memory-service.ts       # +access control checks, +comment methods, +session tracking
  tools/
    memory-comment.ts       # NEW tool
    memory-list-recent.ts   # NEW tool
    memory-get.ts           # +user_id param, +scope check, +comments array, +capabilities
    memory-search.ts        # +user_id required, +slug validation
    memory-create.ts        # +slug validation, +content validation
    memory-update.ts        # +slug validation, +content validation, +scope check
    memory-archive.ts       # +slug validation, +scope check
    memory-verify.ts        # +user_id param, +slug validation, +scope check, +verified_by
    memory-list.ts          # +user_id required, +slug validation, +scope enforcement
    memory-list-stale.ts    # +user_id required, +slug validation, +scope enforcement
    memory-session-start.ts # +slug validation, +session tracking UPSERT, +team_activity
    index.ts                # +registerMemoryComment, +registerMemoryListRecent
tests/
  helpers.ts                # +truncate comments and session_tracking tables
  integration/
    comment.test.ts         # NEW: comment CRUD, threading, access control
    access-control.test.ts  # NEW: scope enforcement across all operations
    team-activity.test.ts   # NEW: session tracking, memory_list_recent
    validation.test.ts      # NEW: slug validation, content validation
```

### Anti-Patterns to Avoid

- **Access control in repository layer:** Keep authorization logic in the service layer. Repositories handle data access only. This is consistent with the existing app-layer filtering pattern.
- **Denormalized comment_count column:** D-59 explicitly forbids this. Always compute via COUNT query. The performance cost is negligible at expected scale.
- **Passing db instance to tools:** Tools call service methods only. The service calls repositories. Never bypass the service layer for "convenience."
- **Breaking existing test patterns:** Add new tests alongside existing ones. Do not modify existing test assertions -- only extend test setup (e.g., user_id parameters).

## Don't Hand-Roll

| Problem                      | Don't Build                       | Use Instead                            | Why                                                                 |
| ---------------------------- | --------------------------------- | -------------------------------------- | ------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| Correlated count subquery    | Manual SQL string concatenation   | `db.$count(comments, eq(...))`         | Type-safe, tested by Drizzle, generates correct correlated subquery |
| UPSERT for session tracking  | SELECT-then-INSERT race condition | `db.insert().onConflictDoUpdate()`     | Atomic, handles concurrent server instances safely                  |
| Slug validation regex        | Inline regex in each tool file    | Shared `slugSchema` from validation.ts | Single source of truth, consistent error messages                   |
| Transaction management       | Manual BEGIN/COMMIT/ROLLBACK      | `db.transaction(async (tx) => {})`     | Drizzle handles cleanup, savepoints, error rollback                 |
| Input trimming + empty check | `if (!content                     |                                        | !content.trim())`                                                   | `z.string().trim().min(1)` | Zod handles trimming + validation + error messages in one chain |

**Key insight:** Phase 3 introduces significant cross-cutting concerns (validation, authorization). These MUST be centralized in shared utilities, not copy-pasted into each tool file. A validation utility module and service-layer authorization methods prevent drift and reduce the surface area for bugs.

## Common Pitfalls

### Pitfall 1: comment_count Returns String Instead of Number

**What goes wrong:** PostgreSQL `COUNT(*)` returns `bigint`, which postgres.js serializes as a string. `comment_count` shows up as `"3"` instead of `3`.
**Why it happens:** bigint exceeds JavaScript's Number.MAX_SAFE_INTEGER range, so drivers default to string representation.
**How to avoid:** Use `db.$count()` which should handle casting, but verify in integration tests. If not, use `sql<number>\`(SELECT COUNT(\*)::int FROM comments ...)\``with explicit`::int`cast, or apply`Number()`conversion in the repository's`rowToMemory` function.
**Warning signs:** Type errors in tests, JSON output showing string numbers.

### Pitfall 2: memoryColumns Object Must Be Updated Everywhere

**What goes wrong:** Adding `verified_by` and `last_comment_at` to the schema but forgetting to add them to the `memoryColumns` constant in `memory-repository.ts` means they silently disappear from all query results.
**Why it happens:** `memoryColumns` is an explicit column selection (D-44: never return embedding vector). Any new column must be manually added.
**How to avoid:** When adding schema columns, immediately update `memoryColumns`, the `Memory` interface, and the `rowToMemory` function. These three must stay in sync.
**Warning signs:** New fields showing up as `undefined` in responses.

### Pitfall 3: LEFT JOIN Multiplies Rows in Search/List

**What goes wrong:** If comment_count is implemented via a LEFT JOIN + GROUP BY instead of a correlated subquery, the JOIN can multiply result rows and corrupt pagination or limit counts.
**Why it happens:** LEFT JOIN produces one row per (memory, comment) pair before grouping.
**How to avoid:** Use `db.$count()` correlated subquery pattern instead of LEFT JOIN + GROUP BY. D-60 mentions "LEFT JOIN cost" but the actual implementation should use correlated subqueries for correctness.
**Warning signs:** Duplicate memories in results, incorrect pagination.

### Pitfall 4: Scope Enforcement on memory_get Returns "Not Found" (not "Forbidden")

**What goes wrong:** D-17 says user-scoped memories return "not found" for non-owners. If you return a 403-style error instead, you leak information about the memory's existence.
**Why it happens:** Natural instinct is to return "access denied" but the decision is deliberate -- hide existence.
**How to avoid:** After fetching a memory by ID, check access. If access denied, throw `NotFoundError` (not a new `AuthorizationError`). Only use descriptive permission errors for mutation operations (update, archive, verify, comment) per D-12.
**Warning signs:** "Cannot modify" error on a GET request.

### Pitfall 5: Transaction Isolation for Comment Creation

**What goes wrong:** Without a transaction, comment insertion succeeds but the parent `updated_at`/`last_comment_at` update fails (or vice versa). Data becomes inconsistent.
**Why it happens:** Two separate queries without transaction guarantees.
**How to avoid:** Always use `db.transaction()` for comment creation. Verify the parent memory exists and is not archived INSIDE the transaction to prevent TOCTOU races.
**Warning signs:** `last_comment_at` is null on a memory that has comments, or `updated_at` doesn't reflect latest comment.

### Pitfall 6: Self-Comment Check Must Use Memory's Author, Not Current user_id

**What goes wrong:** The self-comment block (D-56) should check `memory.author === user_id`. If the check is inverted or uses the wrong field, it blocks everyone except the author.
**Why it happens:** Confusing "the commenter is the author" with "the commenter is not the author."
**How to avoid:** Clear variable naming: `isAuthor = memory.author === userId; if (isAuthor) throw new ValidationError(...)`.
**Warning signs:** All comments are blocked, or self-comments are allowed.

### Pitfall 7: truncateAll Must Include New Tables

**What goes wrong:** Tests pass individually but fail when run together because the comments table or session_tracking table retains data from previous tests.
**Why it happens:** `truncateAll()` in `tests/helpers.ts` only deletes from `memories` and `projects`. New tables must be added in correct FK order.
**How to avoid:** Update `truncateAll()` to delete comments first (references memories), then session_tracking, then memories, then projects.
**Warning signs:** Tests pass individually but fail in suite.

### Pitfall 8: team_activity Query Must Be Scope-Aware

**What goes wrong:** The team_activity counts in `memory_session_start` response include user-scoped memories owned by other users, leaking private information.
**Why it happens:** Using a simple `WHERE created_at > since` without scope filtering.
**How to avoid:** Apply the same scope filtering as search: count project memories for the project + user-scoped memories only for the requesting user.
**Warning signs:** Activity counts differ between users when they should only differ based on their own user-scoped activity.

## Code Examples

### Drizzle Correlated Subquery for comment_count

```typescript
// Source: https://orm.drizzle.team/docs/query-utils ($count section)
// Verified: db.$count exists in installed drizzle-orm@0.45.1 pg-core types

import { eq } from "drizzle-orm";
import { comments, memories } from "../db/schema.js";

// In memory-repository.ts, extend memoryColumns:
const memoryColumnsWithCommentCount = {
  ...memoryColumns,
  verified_by: memories.verified_by,
  last_comment_at: memories.last_comment_at,
  comment_count: db.$count(comments, eq(comments.memory_id, memories.id)),
};
```

### Drizzle UPSERT for Session Tracking

```typescript
// Source: https://orm.drizzle.team/docs/insert (onConflictDoUpdate)
import { sql, eq } from "drizzle-orm";
import { sessionTracking } from "../db/schema.js";

// Returns the previous session timestamp (null if first session)
async function upsertSession(
  userId: string,
  projectId: string,
): Promise<Date | null> {
  // First, get existing session
  const existing = await db
    .select({ last_session_at: sessionTracking.last_session_at })
    .from(sessionTracking)
    .where(
      and(
        eq(sessionTracking.user_id, userId),
        eq(sessionTracking.project_id, projectId),
      ),
    )
    .limit(1);

  const previousSession =
    existing.length > 0 ? existing[0].last_session_at : null;

  // Then upsert (update last_session_at to now)
  await db
    .insert(sessionTracking)
    .values({
      user_id: userId,
      project_id: projectId,
      last_session_at: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [sessionTracking.user_id, sessionTracking.project_id],
      set: { last_session_at: sql`now()` },
    });

  return previousSession;
}
```

### Drizzle Transaction for Comment Creation

```typescript
// Source: https://orm.drizzle.team/docs/transactions
import { sql, eq, and, isNull } from "drizzle-orm";
import { memories, comments } from "../db/schema.js";
import { generateId } from "../utils/id.js";

async function createComment(
  memoryId: string,
  author: string,
  content: string,
): Promise<Comment> {
  return await db.transaction(async (tx) => {
    // Verify parent memory exists and is not archived
    const [parent] = await tx
      .select({ id: memories.id, archived_at: memories.archived_at })
      .from(memories)
      .where(eq(memories.id, memoryId))
      .limit(1);

    if (!parent) throw new NotFoundError("Memory", memoryId);
    if (parent.archived_at)
      throw new ValidationError("Cannot comment on an archived memory.");

    // Insert comment
    const commentId = generateId();
    const [inserted] = await tx
      .insert(comments)
      .values({ id: commentId, memory_id: memoryId, author, content })
      .returning();

    // Update parent timestamps (D-53 + D-62), NOT version (D-54)
    await tx
      .update(memories)
      .set({
        updated_at: sql`now()`,
        last_comment_at: sql`now()`,
      })
      .where(eq(memories.id, memoryId));

    return inserted;
  });
}
```

### Slug Validation with Zod

```typescript
// Source: https://zod.dev/api (regex section)
import { z } from "zod";

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z.string()
  .min(1, "Must not be empty")
  .max(64, "Must be 64 characters or fewer")
  .regex(SLUG_REGEX, "Must be lowercase alphanumeric with hyphens (e.g., 'my-project')");

// Usage in tool input schema:
inputSchema: {
  project_id: slugSchema.describe("Project slug (e.g., 'my-project')"),
  user_id: slugSchema.describe("User identifier (e.g., 'alice')"),
  // ...
}
```

### AuthorizationError for Mutation Operations

```typescript
// src/utils/errors.ts - addition
export class AuthorizationError extends DomainError {
  constructor(message: string) {
    super(message, "AUTHORIZATION_ERROR", 403);
  }
}

// Usage in service layer:
if (memory.scope === "user" && memory.author !== userId) {
  throw new AuthorizationError(
    "Cannot modify user-scoped memory owned by another user.",
  );
}
```

### Envelope Extension for team_activity

```typescript
// src/types/envelope.ts -- extend meta type
export interface Envelope<T> {
  data: T;
  meta: {
    count?: number;
    timing?: number;
    cursor?: string;
    has_more?: boolean;
    team_activity?: {
      // D-29: session_start only
      new_memories: number;
      updated_memories: number;
      commented_memories: number;
      since: string; // ISO timestamp
    };
    comment_count?: number; // D-67: memory_comment response
  };
}
```

## State of the Art

| Old Approach                     | Current Approach                                       | When Changed | Impact                                                                         |
| -------------------------------- | ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------ |
| user_id optional on reads        | user_id required on ALL tools (D-13)                   | Phase 3      | Breaking change for all 9 existing tools. No external consumers so acceptable. |
| No input validation on IDs       | Slug validation on user_id and project_id (D-05/D-09)  | Phase 3      | Prevents garbage values, enforces consistency.                                 |
| Memory type has no comment_count | comment_count computed on every memory response (D-61) | Phase 3      | All downstream consumers see comment info.                                     |
| verify sets verified_at only     | verify also sets verified_by (D-19)                    | Phase 3      | Provenance for verification actions.                                           |

## Open Questions

1. **db.$count() return type with postgres.js**
   - What we know: PostgreSQL COUNT returns bigint, postgres.js returns string for bigint. Drizzle's `$count` utility should handle conversion but this is unverified for our specific driver pairing.
   - What's unclear: Whether `db.$count()` used as a correlated subquery in `.select()` automatically handles the bigint-to-number conversion.
   - Recommendation: Test in first integration test. If it returns string, fall back to raw `sql<number>\`(SELECT COUNT(\*)::int ...)\`` pattern.

2. **session_tracking composite primary key in Drizzle**
   - What we know: Drizzle supports composite primary keys via `primaryKey()` helper in table definition.
   - What's unclear: Whether `onConflictDoUpdate` with composite `target` array works seamlessly with a composite primary key (vs. unique index).
   - Recommendation: Use a composite unique index `unique("session_tracking_user_project_idx").on(user_id, project_id)` as the conflict target. Verified in Drizzle docs that arrays work for `target`.

3. **memoryColumns refactoring approach**
   - What we know: Current `memoryColumns` is a const object. Adding `db.$count()` requires a `db` reference, meaning it can't be a module-level const.
   - What's unclear: Whether to make it a function `getMemoryColumns(db)` or a method on the repository class.
   - Recommendation: Convert to a method `private memoryColumns()` on `DrizzleMemoryRepository` that returns the columns object. The `db` instance is already available via `this.db`.

## Validation Architecture

### Test Framework

| Property           | Value                               |
| ------------------ | ----------------------------------- |
| Framework          | Vitest 4.1.0                        |
| Config file        | `vitest.config.ts`                  |
| Quick run command  | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run`                    |

### Phase Requirements -> Test Map

| Req ID  | Behavior                                          | Test Type   | Automated Command                                                                 | File Exists? |
| ------- | ------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- | ------------ |
| TEAM-01 | Two users read/write shared project memories      | integration | `npx vitest run tests/integration/access-control.test.ts -t "shared project" -x`  | Wave 0       |
| TEAM-02 | user_id identifies each writer                    | integration | `npx vitest run tests/integration/access-control.test.ts -t "author tracking" -x` | Wave 0       |
| TEAM-03 | Memory records author + verified_by               | integration | `npx vitest run tests/integration/access-control.test.ts -t "provenance" -x`      | Wave 0       |
| TEAM-04 | Comment appended to memory                        | integration | `npx vitest run tests/integration/comment.test.ts -t "create comment" -x`         | Wave 0       |
| TEAM-05 | Comments preserve original, add context           | integration | `npx vitest run tests/integration/comment.test.ts -t "preserves original" -x`     | Wave 0       |
| TEAM-06 | User verifies memory with verified_by             | integration | `npx vitest run tests/integration/access-control.test.ts -t "verify" -x`          | Wave 0       |
| TEAM-07 | Agent lists stale memories with scope enforcement | integration | `npx vitest run tests/integration/access-control.test.ts -t "stale" -x`           | Wave 0       |

### Additional Test Coverage (beyond requirements)

| Behavior                                           | Test Type   | Automated Command                                                            | File Exists? |
| -------------------------------------------------- | ----------- | ---------------------------------------------------------------------------- | ------------ |
| Slug validation rejects invalid user_id/project_id | unit        | `npx vitest run tests/unit/validation.test.ts -x`                            | Wave 0       |
| Content validation rejects empty/whitespace        | unit        | `npx vitest run tests/unit/validation.test.ts -x`                            | Wave 0       |
| Self-comment blocked                               | integration | `npx vitest run tests/integration/comment.test.ts -t "self-comment" -x`      | Wave 0       |
| User-scoped memory hidden from non-owner           | integration | `npx vitest run tests/integration/access-control.test.ts -t "user scope" -x` | Wave 0       |
| Session tracking + team_activity                   | integration | `npx vitest run tests/integration/team-activity.test.ts -x`                  | Wave 0       |
| memory_list_recent with exclude_self               | integration | `npx vitest run tests/integration/team-activity.test.ts -t "list_recent" -x` | Wave 0       |
| Capability booleans on memory_get                  | integration | `npx vitest run tests/integration/comment.test.ts -t "capabilities" -x`      | Wave 0       |
| Comment on archived memory blocked                 | integration | `npx vitest run tests/integration/comment.test.ts -t "archived" -x`          | Wave 0       |

### Sampling Rate

- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/integration/access-control.test.ts` -- covers TEAM-01, TEAM-02, TEAM-03, TEAM-06, TEAM-07
- [ ] `tests/integration/comment.test.ts` -- covers TEAM-04, TEAM-05, self-comment block, archived block, capabilities
- [ ] `tests/integration/team-activity.test.ts` -- covers session tracking, team_activity, memory_list_recent
- [ ] `tests/unit/validation.test.ts` -- covers slug validation, content validation
- [ ] Update `tests/helpers.ts` -- add comments and session_tracking to truncateAll()

## Project Constraints (from CLAUDE.md)

- **Protocol:** MCP server via stdio transport only for v1. All logging to stderr.
- **Stack:** TypeScript 5.9.x, Node 22 LTS, drizzle-orm 0.45.x + drizzle-kit 0.31.x, postgres.js 3.4.x, zod 4.x.
- **Forbidden:** console.log (corrupts stdio), LangChain, Prisma, drizzle-orm 1.0 beta, TypeScript 6.0 RC, dedicated vector DBs.
- **Testing:** Vitest 4.1.x, integration tests against Docker Postgres, fileParallelism disabled.
- **IDs:** nanoid(21) via `generateId()`.
- **Envelope:** Standard `{ data, meta }` response format on all tools.
- **Errors:** DomainError subclasses caught by `withErrorHandling`, unknown errors rethrown to MCP SDK.
- **GSD Workflow:** Follow GSD commands for all edits.

## Sources

### Primary (HIGH confidence)

- Existing codebase: `src/db/schema.ts`, `src/repositories/memory-repository.ts`, `src/services/memory-service.ts`, `src/tools/*.ts` -- current implementation patterns
- [Drizzle ORM Select docs](https://orm.drizzle.team/docs/select) -- subquery patterns, `$count()` correlated subquery
- [Drizzle ORM Query Utils](https://orm.drizzle.team/docs/query-utils) -- `$count()` utility function API
- [Drizzle ORM Transactions](https://orm.drizzle.team/docs/transactions) -- transaction API, PostgreSQL-specific config
- [Drizzle ORM Insert docs](https://orm.drizzle.team/docs/insert) -- `onConflictDoUpdate` UPSERT pattern
- [Drizzle ORM Count Rows guide](https://orm.drizzle.team/docs/guides/count-rows) -- PostgreSQL bigint-to-string caveat
- Installed package versions verified: drizzle-orm@0.45.1, drizzle-kit@0.31.10, vitest@4.1.0, zod@4.3.6
- `db.$count` type signature verified in `node_modules/drizzle-orm/pg-core/db.d.ts`
- [Zod API docs](https://zod.dev/api) -- `.regex()`, `.trim()`, `.min()` string validators

### Secondary (MEDIUM confidence)

- [Drizzle ORM PostgreSQL Best Practices 2025](https://gist.github.com/productdevbook/7c9ce3bbeb96b3fabc3c7c2aa2abc717) -- general patterns
- Phase 3 CONTEXT.md decisions (D-01 through D-76) -- user-locked design decisions

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH -- no new dependencies, all tools verified in installed node_modules
- Architecture: HIGH -- extends established patterns from Phases 1-2, Drizzle APIs verified
- Pitfalls: HIGH -- based on concrete codebase analysis and known PostgreSQL/Drizzle behaviors
- Access control model: HIGH -- fully specified in CONTEXT.md decisions, simple two-tier model
- Comment system: HIGH -- straightforward relational design, well-defined in decisions
- db.$count() integration: MEDIUM -- API exists and types verified, but runtime behavior with postgres.js bigint needs integration test confirmation

**Research date:** 2026-03-23
**Valid until:** 2026-04-23 (30 days -- stable domain, no external dependency changes expected)
