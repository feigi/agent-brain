# Phase 3: Team Collaboration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-23
**Phase:** 03-team-collaboration
**Areas discussed:** Authentication model, Multi-user access, Comment data model, Comment tool design

---

## Authentication Model

| Option | Description | Selected |
|--------|-------------|----------|
| Trust the client | Keep user_id as per-call param, no server-side verification. Stdio = implicit trust. | ✓ |
| Static bearer tokens | Pre-shared tokens validated per request. Requires HTTP transport. | |
| API key per user | Server-managed keys with rotation. Requires HTTP transport. | |

**User's choice:** Trust the client
**Notes:** Simplest path — no auth infrastructure needed.

| Option | Description | Selected |
|--------|-------------|----------|
| Config default user_id | USER_ID env var as default, override per-call | |
| Keep per-call only | Every call must explicitly pass user_id | ✓ |

**User's choice:** Keep per-call only
**Notes:** Consistent with project_id being per-call.

| Option | Description | Selected |
|--------|-------------|----------|
| Trust is sufficient for v1 | Provenance via author field satisfies TEAM-02 | ✓ |
| Add RLS enforcement | Postgres RLS policies enforce user_id matching | |

**User's choice:** Trust is sufficient for v1

| Option | Description | Selected |
|--------|-------------|----------|
| No client tracking | user_id and source field are sufficient | ✓ |
| Add agent_id field | New optional field to record which client performed operation | |

**User's choice:** No client tracking

| Option | Description | Selected |
|--------|-------------|----------|
| Validate format | Enforce slug-like format for user_id | ✓ |
| Accept any string | No format enforcement | |

**User's choice:** Validate format

| Option | Description | Selected |
|--------|-------------|----------|
| All tools (retroactive) | Apply slug validation to user_id on every tool | ✓ |
| New tools only | Only validate on new Phase 3 tools | |

**User's choice:** All tools

| Option | Description | Selected |
|--------|-------------|----------|
| Validate new writes only | Existing memories keep whatever author string | ✓ |
| Migrate + validate | Normalize existing author values then enforce | |

**User's choice:** Validate new writes only

| Option | Description | Selected |
|--------|-------------|----------|
| No users table | Authors remain plain strings | ✓ |
| Users table | Add users table with auto-create | |

**User's choice:** No users table

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, same validation | project_id also gets slug validation | ✓ |
| No, project_id is fine | Don't touch project_id validation | |

**User's choice:** Yes, same validation

| Option | Description | Selected |
|--------|-------------|----------|
| Author-only writes | Only original author can update/archive | |
| Any user can edit any | All team members have equal access | |

**User's choice:** Clarified — project memories can be edited by everyone, user memories only by the author.

| Option | Description | Selected |
|--------|-------------|----------|
| Anyone can verify | Any team member can confirm accuracy | ✓ |
| Author-only verify | Only author can mark as verified | |

**User's choice:** Anyone can verify (later refined: owner-only for user-scoped)

| Option | Description | Selected |
|--------|-------------|----------|
| Reads stay anonymous | No user_id on read operations for audit | ✓ |
| Optional user_id on reads | Add for audit trail | |

**User's choice:** Reads stay anonymous (later refined: user_id required for scope enforcement, but no audit logging)

| Option | Description | Selected |
|--------|-------------|----------|
| Track verified_by | Add verified_by field alongside verified_at | ✓ |
| Timestamp only | Just update verified_at | |

**User's choice:** Track verified_by

| Option | Description | Selected |
|--------|-------------|----------|
| Enforce scope on get | memory_get checks scope+author for user-scoped | ✓ |
| No access control on get | Any memory accessible by ID | |

**User's choice:** Enforce scope on get

| Option | Description | Selected |
|--------|-------------|----------|
| Enforce on list too | memory_list with scope=user only returns user's own | ✓ |
| Get only | Only memory_get enforces scope | |

**User's choice:** Enforce on list too

| Option | Description | Selected |
|--------|-------------|----------|
| Required on all | user_id required on every tool call | ✓ |
| Optional on reads | user_id optional on read tools | |

**User's choice:** Required on all

| Option | Description | Selected |
|--------|-------------|----------|
| Required always | user_id required on memory_search regardless of scope | ✓ |
| Keep conditional | Only required when scope='both' or scope='user' | |

**User's choice:** Required always

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, same pattern | Archive follows scope rules | ✓ |
| Archiving is author-only always | Only original author can archive any memory | |

**User's choice:** Yes, same pattern

| Option | Description | Selected |
|--------|-------------|----------|
| Owner only | User-scoped memories: only owner can comment | ✓ |
| Anyone can comment | Comments always open regardless of scope | |

**User's choice:** Owner only

| Option | Description | Selected |
|--------|-------------|----------|
| Owner-only for user scope | Verify follows same access rules per scope | ✓ |
| Keep anyone-can-verify | Verify as special case regardless of scope | |

**User's choice:** Owner-only for user scope

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, enforce privacy | Add user_id to list_stale, filter other users' user-scoped | ✓ |
| Project-only stale list | list_stale only operates on project-scoped | |

**User's choice:** Yes, enforce privacy

| Option | Description | Selected |
|--------|-------------|----------|
| Clear permission error | Specific error for non-author update attempts | ✓ |
| Not found | Same error as missing ID | |

**User's choice:** Clear permission error

---

## Multi-user Access

| Option | Description | Selected |
|--------|-------------|----------|
| Shared DB, stdio per user | Each user runs own server, shared Postgres | ✓ |
| Add HTTP transport | Single shared server with auth | |
| Both transports | Stdio for local, HTTP for team | |

**User's choice:** Shared DB, stdio per user

| Option | Description | Selected |
|--------|-------------|----------|
| Documentation only | Document setup pattern, no code changes | ✓ |
| Config validation on startup | Warn if localhost with other users' data | |

**User's choice:** Documentation only
**Notes:** User asked for clarification on the validation option. Agreed it's an ops concern.

| Option | Description | Selected |
|--------|-------------|----------|
| Optimistic locking is enough | Phase 1 version column handles conflicts | ✓ |
| Add advisory locks | Postgres advisory locks for critical operations | |

**User's choice:** Optimistic locking is enough

| Option | Description | Selected |
|--------|-------------|----------|
| Add migration locking | Advisory locks during migration | ✓ |
| No concern | Small team, coordinated updates | |

**User's choice:** Add migration locking

| Option | Description | Selected |
|--------|-------------|----------|
| Limit to 3 per instance | Hardcoded pool size | ✓ |
| Default pool is fine | Keep postgres.js default of 10 | |

**User's choice:** Limit to 3, hardcoded (no env var)

| Option | Description | Selected |
|--------|-------------|----------|
| Out of scope | No contributor listing tool | |
| Add list_contributors | New tool for distinct authors | ✓ → later removed |

**User's choice:** Initially added, later removed — derivable from memory_list_recent.

| Option | Description | Selected |
|--------|-------------|----------|
| Add memory_list_recent | New tool for recent activity | ✓ |
| Not in Phase 3 | Defer to future phase | |

**User's choice:** Add memory_list_recent

| Option | Description | Selected |
|--------|-------------|----------|
| ISO timestamp only | Agent passes explicit datetime | ✓ |
| Support relative + absolute | Accept '24h', '7d' etc. | |

**User's choice:** ISO timestamp only

| Option | Description | Selected |
|--------|-------------|----------|
| Add change_type field | 'created' or 'updated' per result | ✓ |
| No distinction | Just return memories sorted by activity | |

**User's choice:** Add change_type field (later expanded to include 'commented')

| Option | Description | Selected |
|--------|-------------|----------|
| Add exclude_self option | Optional boolean, default false | ✓ |
| Show everything | Always include user's own changes | |

**User's choice:** Add exclude_self option

| Option | Description | Selected |
|--------|-------------|----------|
| 10 (match existing) | Consistent with other tools | ✓ |
| 20 | Wider window for recent changes | |

**User's choice:** 10

| Option | Description | Selected |
|--------|-------------|----------|
| Record session_start calls | Track last_session_at per user/project | ✓ |
| Use a fixed window | Always show last 24 hours | |

**User's choice:** Record session_start calls

| Option | Description | Selected |
|--------|-------------|----------|
| Latest only | Single row per (user_id, project_id) | ✓ |
| Full history | Append-only log of all session starts | |

**User's choice:** Latest only

| Option | Description | Selected |
|--------|-------------|----------|
| Summary counts | { new_memories, updated_memories, active_contributors, since } | ✓ → refined |
| Per-contributor breakdown | Detailed per-user counts | |

**User's choice:** Summary counts (later refined: dropped active_contributors, added commented_memories)

**User clarification:** team_activity should include the user's own changes. Also memory_list_recent should include own changes by default. Rationale: new sessions need full context of what happened.

| Option | Description | Selected |
|--------|-------------|----------|
| Last 7 days | Default for first session | ✓ |
| All activity | Full project state | |
| Empty / null | No delta on first session | |

**User's choice:** Last 7 days, hardcoded

| Option | Description | Selected |
|--------|-------------|----------|
| In meta | team_activity as metadata | ✓ |
| In data | Would change data from array to object (breaking) | |

**User's choice:** In meta

| Option | Description | Selected |
|--------|-------------|----------|
| Created and updated | Show any memory with activity after timestamp | ✓ |
| Created only | Only new memories | |

**User's choice:** Created and updated

| Option | Description | Selected |
|--------|-------------|----------|
| Exclude self (for team_activity) | Only show teammate changes | → reversed |
| Include self | Show all activity | ✓ |

**User's choice:** Include self (user reversed earlier "exclude self" decision)

---

## Comment Data Model

| Option | Description | Selected |
|--------|-------------|----------|
| Separate table | Dedicated comments table with FK to memories | ✓ |
| JSONB array on memory | Simpler schema, atomic reads | |

**User's choice:** Separate table

| Option | Description | Selected |
|--------|-------------|----------|
| Flat | All comments directly on the memory | ✓ |
| Nested/threaded | Comments can reply to other comments | |

**User's choice:** Flat

| Option | Description | Selected |
|--------|-------------|----------|
| Append-only | No editing or deleting | ✓ |
| Editable + deletable | Author can edit or delete | |
| Deletable only | Delete but no edit | |

**User's choice:** Append-only

| Option | Description | Selected |
|--------|-------------|----------|
| Basics only | id, memory_id, author, content, created_at | ✓ |
| Add source field | Include source for Phase 4 agent auto-comments | |
| Add metadata JSONB | Extensibility | |

**User's choice:** Basics only

| Option | Description | Selected |
|--------|-------------|----------|
| Keep comments | No cascade on archive | ✓ |
| Cascade archive | Mark comments archived too | |

**User's choice:** Keep comments

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, update parent | Comment bumps memory's updated_at | ✓ |
| No, independent | Comments don't affect timestamps | |

**User's choice:** Yes, update parent

| Option | Description | Selected |
|--------|-------------|----------|
| Always compute | COUNT query with index | ✓ |
| Denormalize count | comment_count column on memories | |

**User's choice:** Always compute

| Option | Description | Selected |
|--------|-------------|----------|
| Inherit parent scope | No separate scope on comments | ✓ |
| Independent scope | Own visibility rules | |

**User's choice:** Inherit parent scope

| Option | Description | Selected |
|--------|-------------|----------|
| Shorter limit (~1000 chars) | Encourage concise comments | ✓ |
| Same as memories (~4000) | Apply same limit | |
| No limit | Trust the user | |

**User's choice:** ~1000 chars

| Option | Description | Selected |
|--------|-------------|----------|
| No version bump | Comments don't change content | ✓ |
| Bump version | Any mutation increments version | |

**User's choice:** No version bump

| Option | Description | Selected |
|--------|-------------|----------|
| Include comment count everywhere | All tools return comment_count, full comments on get | ✓ |
| Include on memory_get only | Full comments only on get | |
| Never auto-include | Dedicated comment tool only | |

**User's choice:** Include comment count everywhere

| Option | Description | Selected |
|--------|-------------|----------|
| Soft limit (~50) | Warn after 50 comments | ✓ |
| No limit | Trust the user | |

**User's choice:** Soft limit ~50

| Option | Description | Selected |
|--------|-------------|----------|
| No embedding impact | Comments don't affect vector | ✓ |
| Re-embed with comments | Concatenate and re-embed | |

**User's choice:** No embedding impact

| Option | Description | Selected |
|--------|-------------|----------|
| Nanoid | Consistent with memory IDs | ✓ |
| Sequential integer | Simpler, naturally ordered | |

**User's choice:** Nanoid

| Option | Description | Selected |
|--------|-------------|----------|
| Join through memory | No denormalized project_id | ✓ |
| Denormalize project_id | Store on each comment | |

**User's choice:** Join through memory

| Option | Description | Selected |
|--------|-------------|----------|
| No comments on archived | Return error | ✓ |
| Allow comments on archived | Post-mortem notes | |

**User's choice:** No comments on archived

| Option | Description | Selected |
|--------|-------------|----------|
| Add 'commented' type | change_type distinguishes comments from edits | ✓ |
| Keep as 'updated' | Comment-bumped shows as 'updated' | |

**User's choice:** Add 'commented' type

| Option | Description | Selected |
|--------|-------------|----------|
| Add last_comment_at | New timestamp on memories for detection | ✓ |
| Check comments table | JOIN for detection | |

**User's choice:** Add last_comment_at

| Option | Description | Selected |
|--------|-------------|----------|
| Add to base Memory type | comment_count and last_comment_at always present | ✓ |
| Extended type | Separate MemoryWithComments | |

**User's choice:** Add to base Memory type

| Option | Description | Selected |
|--------|-------------|----------|
| Accept the JOIN cost | LEFT JOIN on every query | ✓ |
| Make count optional | Skip on search for performance | |

**User's choice:** Accept the JOIN cost

---

## Comment Tool Design

| Option | Description | Selected |
|--------|-------------|----------|
| memory_comment | Consistent with memory_ namespace | ✓ |
| memory_add_comment | More explicit but breaks single-verb pattern | |
| comment_memory | Original name from Phase 1 deferral | |

**User's choice:** memory_comment

| Option | Description | Selected |
|--------|-------------|----------|
| Just the new comment | Lightweight, agent calls get for full picture | ✓ |
| Full memory + all comments | Complete context after commenting | |
| Memory + new comment only | Middle ground | |

**User's choice:** Just the new comment

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal params | memory_id, content, user_id | ✓ |
| Add optional project_id | For consistency validation | |

**User's choice:** Minimal params

| Option | Description | Selected |
|--------|-------------|----------|
| memory_get is sufficient | Returns full comments | ✓ |
| Add memory_list_comments | Paginated comment retrieval | |

**User's choice:** memory_get is sufficient

| Option | Description | Selected |
|--------|-------------|----------|
| Memory not found error | Consistent with other tools | ✓ |

**User's choice:** Memory not found

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, with example | Include usage guidance | ✓ |
| Description only | Self-explanatory tool | |

**User's choice:** Yes, with example

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, include count | comment_count in response meta | ✓ |
| No extra meta | Standard meta only | |

**User's choice:** Yes, include count

| Option | Description | Selected |
|--------|-------------|----------|
| 12 tools is fine | Each tool has clear purpose | |
| Remove memory_list_contributors | Derivable from memory_list_recent | ✓ |

**User's choice:** Remove — "it is enough to get user_ids via memory_list_recent. That's like 'recent contributors'"

| Option | Description | Selected |
|--------|-------------|----------|
| Counts only | team_activity: no contributor names | ✓ |
| Keep contributors in summary | Distinct author slugs in team_activity | |

**User's choice:** Counts only

| Option | Description | Selected |
|--------|-------------|----------|
| Split into three counts | new_memories, updated_memories, commented_memories | ✓ |
| Keep two counts | new + updated only | |

**User's choice:** Split into three counts

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, update all descriptions | Refresh for Phase 3 changes | ✓ |
| New tools only | Existing tools keep old descriptions | |

**User's choice:** Update all descriptions

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, reject empty | Non-empty after trim | ✓ |
| (implied) | Apply to all content fields retroactively | ✓ |

**User's choice:** Reject empty, apply to all tools

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, include guidance | When to comment vs update | ✓ |
| No guidance | Let agents figure it out | |

**User's choice:** Include guidance

| Option | Description | Selected |
|--------|-------------|----------|
| Block self-comments | Author cannot comment on own memory | ✓ |
| Allow self-comments | Anyone can comment on accessible memories | |

**User's choice:** Block self-comments
**Notes:** Confirmed that user-scoped memories having no comments is intended. Comments are a team collaboration feature; user-scoped memories are personal.

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, helpful error | Guide to memory_update | ✓ |
| Generic permission error | Standard denial | |

**User's choice:** Helpful error

| Option | Description | Selected |
|--------|-------------|----------|
| Oldest first (chronological) | Natural conversation order | ✓ |
| Newest first | Most recent first | |

**User's choice:** Oldest first

| Option | Description | Selected |
|--------|-------------|----------|
| Only on memory_get | Extended response with comments array | ✓ |
| Always present (empty array) | Base type includes empty comments | |

**User's choice:** Only on memory_get

| Option | Description | Selected |
|--------|-------------|----------|
| Add can_comment | Capability boolean on memory_get | ✓ |
| No capability hints | Agent tries and gets error | |

**User's choice:** Add can_comment — expanded to full set: can_comment, can_edit, can_archive, can_verify

| Option | Description | Selected |
|--------|-------------|----------|
| memory_get only | Capability booleans on detailed view only | ✓ |
| All memory responses | Every tool includes capabilities | |

**User's choice:** memory_get only

| Option | Description | Selected |
|--------|-------------|----------|
| Keep 0.1.0 | No version bump | ✓ |
| Bump to 0.2.0 | Signal breaking changes | |

**User's choice:** Keep 0.1.0

| Option | Description | Selected |
|--------|-------------|----------|
| Not a concern | Small team, coordinated updates | ✓ |
| Yes, backwards-compatible | Additive only, nullable columns | |

**User's choice:** Not a concern

---

## Claude's Discretion

- Exact slug validation regex and max length
- Database indexes on comments table
- Comment creation + parent updated_at as transaction
- Error handling for edge cases beyond discussed ones
- memory_list_recent sort order
- Tool description exact wording

## Deferred Ideas

None — discussion stayed within phase scope.
