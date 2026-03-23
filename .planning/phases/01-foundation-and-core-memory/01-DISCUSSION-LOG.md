# Phase 1: Foundation and Core Memory - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-23
**Phase:** 01-foundation-and-core-memory
**Areas discussed:** MCP tool interface, Memory structure, Project config, Search defaults, Transport & deployment, Embedding resilience, Local dev experience, Concurrency & conflicts

---

## MCP Tool Interface

| Option | Description | Selected |
|--------|-------------|----------|
| save_note / search_memory | Matches existing CLAUDE.md agent-memory config naming | |
| save_memory / search_memory | Consistent 'memory' noun throughout | |
| memory_create, memory_get, etc. | CRUD-style verbs with namespace prefix | ✓ |

**User's choice:** CRUD-style with `memory_` namespace prefix
**Notes:** "We need full CRUD, so 3."

---

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal — just the data | Return memory object directly | |
| Envelope — data + metadata | Wrap in { data, meta } | ✓ |
| Rich — data + context | Include related info like similar memories | |

**User's choice:** Envelope response structure

---

| Option | Description | Selected |
|--------|-------------|----------|
| Required | Forces explicit labeling | |
| Optional, auto-generate | Accept untitled, generate from content | ✓ |
| Optional, no auto-gen | Left null if not provided | |

**User's choice:** Optional with auto-generation

---

| Option | Description | Selected |
|--------|-------------|----------|
| Semantic only | Pure vector similarity, tag filtering in Phase 2 | ✓ |
| Semantic + tag filter | Allow optional tag filter param from day one | |

**User's choice:** Semantic only (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| MCP error codes + message | Standard MCP error response | |
| Typed error responses | Structured errors with error_type | |
| You decide | Claude picks best approach | ✓ |

**User's choice:** Claude's discretion

---

| Option | Description | Selected |
|--------|-------------|----------|
| Single only | One memory per call | |
| Single + bulk | Accept single ID or array | ✓ |

**User's choice:** Single + bulk archive

---

| Option | Description | Selected |
|--------|-------------|----------|
| Search only | Semantic search or by known ID | |
| List + search | Add paginated browse tool | ✓ |

**User's choice:** List + search

---

| Option | Description | Selected |
|--------|-------------|----------|
| Per-call scope param | Each call includes scope: project/user | ✓ |
| Server config default | Default from config, override per-call | |
| You decide | Claude picks | |

**User's choice:** Per-call scope parameter

---

| Option | Description | Selected |
|--------|-------------|----------|
| Partial (PATCH-style) | Only send fields to change | ✓ |
| Full replace (PUT-style) | Send complete object | |

**User's choice:** Partial updates (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Defer to Phase 3 | TEAM-04/05 mapped to Phase 3 | ✓ |
| Include in Phase 1 | Add comment_memory now | |

**User's choice:** Defer comments to Phase 3

---

| Option | Description | Selected |
|--------|-------------|----------|
| Defer to Phase 3 | TEAM-06 mapped to Phase 3 | |
| Include in Phase 1 | Simple timestamp update | ✓ |

**User's choice:** Include verify in Phase 1

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, include it | Natural companion to verify | ✓ |
| Defer to Phase 3 | Keep with TEAM requirements | |

**User's choice:** Include list_stale in Phase 1

---

| Option | Description | Selected |
|--------|-------------|----------|
| Tools only | No MCP resources | ✓ |
| Tools + resources | Expose read-only resources | |

**User's choice:** Tools only (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, with default | Optional limit param, default 10 | ✓ |
| Fixed limit | Always return fixed number | |

**User's choice:** Configurable limit with default

---

| Option | Description | Selected |
|--------|-------------|----------|
| memory_create, etc. (underscore) | Matches common MCP patterns | ✓ |
| mem_create, etc. | Shorter prefix | |
| brain_create, etc. | Matches project name | |

**User's choice:** `memory_` namespace prefix

---

| Option | Description | Selected |
|--------|-------------|----------|
| Params + examples | Include usage examples in descriptions | ✓ |
| Params only | Minimal descriptions | |

**User's choice:** Params + examples (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Looks right | 8 tools confirmed | ✓ |
| Remove something | Trim the list | |
| Add something | Missing a tool | |

**User's choice:** Confirmed 8-tool inventory

---

## Memory Structure

| Option | Description | Selected |
|--------|-------------|----------|
| nanoid | URL-safe 21-char IDs | |
| UUID v7 | Time-sortable UUIDs | |
| You decide | Claude picks | ✓ |

**User's choice:** Claude's discretion

---

| Option | Description | Selected |
|--------|-------------|----------|
| Free-form strings | Any string as tag | |
| Predefined categories | Fixed set from requirements | |
| Both — type + tags | Required type + optional free-form tags | ✓ |

**User's choice:** Both — predefined type enum + free-form tags

---

| Option | Description | Selected |
|--------|-------------|----------|
| Content only | Embed just content | |
| Title + content | Concatenate for embedding | ✓ |
| Title + content + tags | Include everything | |

**User's choice:** Title + content (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Soft limit | Warn at ~4000 chars, allow longer | ✓ |
| Hard limit | Reject over threshold | |
| No limit | Accept any length | |

**User's choice:** Soft limit (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Full lifecycle | created_at, updated_at, verified_at, archived_at | ✓ |
| Minimal | Just created_at and updated_at | |

**User's choice:** Full lifecycle timestamps (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Per-memory | Each memory records model + dimensions | ✓ |
| Global config | Store once in settings table | |

**User's choice:** Per-memory embedding metadata (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — optional source | Record origin type | ✓ |
| Defer to Phase 4 | Add with Agent Autonomy | |
| You decide | Claude picks | |

**User's choice:** Include optional source field

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — optional session_id | Links memories to sessions | ✓ |
| Defer to Phase 2 | Add with session lifecycle | |
| You decide | Claude picks | |

**User's choice:** Include optional session_id field

---

| Option | Description | Selected |
|--------|-------------|----------|
| Include from Phase 1 | Record author from day one | ✓ |
| Defer to Phase 3 | Add with team features | |

**User's choice:** Include author from Phase 1

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — optional JSON field | Flexible catch-all | ✓ |
| No — explicit fields only | Named columns only | |

**User's choice:** Include metadata JSONB field

---

| Option | Description | Selected |
|--------|-------------|----------|
| Auto re-embed on update | Trigger new embedding on content change | ✓ |
| Manual re-embed | Only on explicit request | |
| You decide | Claude picks | |

**User's choice:** Auto re-embed on update (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Retain vector | Keep embedding for potential un-archive | |
| Drop vector | Remove to save storage | ✓ |

**User's choice:** Drop vector on archive

---

| Option | Description | Selected |
|--------|-------------|----------|
| Database enum | PostgreSQL enum type | ✓ |
| Application validation | Validate in code | |
| You decide | Claude picks | |

**User's choice:** Database enum (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| No linking | Independent memories | ✓ |
| Optional links | Junction table for relationships | |

**User's choice:** No linking (recommended)

---

## Project Config

| Option | Description | Selected |
|--------|-------------|----------|
| Environment variable | One server per project | |
| Per-call parameter | Agent passes project_id per call | ✓ |
| Auto-detect from cwd | Read working directory | |
| You decide | Claude picks | |

**User's choice:** Per-call parameter

---

| Option | Description | Selected |
|--------|-------------|----------|
| Slug string | Human-readable, must be unique | ✓ |
| Generated ID | nanoid/UUID, opaque | |
| Both — slug + ID | Internal ID + readable slug | |

**User's choice:** Slug string (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — env var default | DEFAULT_PROJECT, optional override | |
| No default — always explicit | Every call must specify | ✓ |
| You decide | Claude picks | |

**User's choice:** No default — always explicit

---

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-create | First memory with new slug creates project | ✓ |
| Explicit creation | Require project_create tool call | |
| You decide | Claude picks | |

**User's choice:** Auto-create (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| DATABASE_URL env var | Standard connection string | ✓ |
| Individual env vars | Separate DB_HOST, etc. | |
| You decide | Claude picks | |

**User's choice:** DATABASE_URL (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Default credential chain | env vars → IAM → SSO | ✓ |
| Explicit env vars only | Require access key/secret | |

**User's choice:** Default credential chain (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| RLS from day one | Postgres RLS policies | |
| App-level filtering first | WHERE clauses | ✓ |

**User's choice:** App-level filtering first

---

| Option | Description | Selected |
|--------|-------------|----------|
| Required on writes | Every write must include user_id | ✓ |
| Optional with fallback | Omit = anonymous/system | |
| You decide | Claude picks | |

**User's choice:** Required on writes

---

| Option | Description | Selected |
|--------|-------------|----------|
| .env via dotenv | Load .env for dev | ✓ |
| Real env vars only | No dotenv | |

**User's choice:** .env via dotenv (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — memory_status | Returns server/DB/embedding status | |
| No — not needed | If tools work, server is healthy | ✓ |

**User's choice:** No health check tool

---

## Search Defaults

| Option | Description | Selected |
|--------|-------------|----------|
| 10 | Top-10 results | ✓ |
| 5 | Tight results | |
| 20 | Comprehensive | |

**User's choice:** 10 (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — configurable per-call | Default threshold with override | ✓ |
| No threshold | Return top-N regardless | |
| You decide | Claude picks | |

**User's choice:** Configurable threshold (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Full memory + score | Complete object plus similarity score | ✓ |
| Summary + score | ID, title, score, truncated preview | |
| You decide | Claude picks | |

**User's choice:** Full memory + score (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Results only | No debug info | ✓ |
| Optional debug mode | Include vectors/timing when debug=true | |

**User's choice:** Results only (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — sort parameter | sort_by + order params | ✓ |
| Fixed sort — newest first | Always reverse chronological | |

**User's choice:** Sort parameter (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Cursor-based | Cursor token for next page | ✓ |
| Offset-based | Page/offset + limit | |
| You decide | Claude picks | |

**User's choice:** Cursor-based pagination (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| One project per search | Scoped to provided project_id | ✓ |
| Allow multi-project | Array of IDs or 'all' | |

**User's choice:** One project per search (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — type and tag filters | Optional filter params | ✓ |
| No filters — just list all | Filtering in Phase 2 | |
| You decide | Claude picks | |

**User's choice:** Type and tag filters on memory_list

---

## Transport & Deployment

| Option | Description | Selected |
|--------|-------------|----------|
| Stdio only | Standard local MCP transport | ✓ |
| Stdio + HTTP | Also Streamable HTTP | |
| HTTP only | Persistent HTTP service | |

**User's choice:** Stdio only (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| npx tsx src/server.ts | Direct TypeScript execution | ✓ |
| Compiled JS + node | Build to dist/ | |
| You decide | Claude picks | |

**User's choice:** npx tsx (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — graceful | Finish pending writes before exit | ✓ |
| No — immediate exit | Exit on signal | |

**User's choice:** Graceful shutdown (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — startup banner | Log version, DB, embedding to stderr | ✓ |
| Silent start | No output unless error | |

**User's choice:** Startup banner (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-migrate on startup | Run pending migrations on connect | ✓ |
| Separate migration command | Manual drizzle-kit migrate | |
| Both — configurable | Auto by default, disable via env var | |

**User's choice:** Auto-migrate on startup (recommended)

---

## Embedding Resilience

| Option | Description | Selected |
|--------|-------------|----------|
| Fail the save | Return error, no partial state | ✓ |
| Save without embedding | Store with null vector | |
| Queue for retry | Save, mark pending, retry later | |

**User's choice:** Fail the save

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — mock provider | Deterministic hash-based vectors | ✓ |
| No — always real | Require Bedrock access | |

**User's choice:** Mock provider (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic | Hash input for consistent vectors | ✓ |
| Random | Random vectors each time | |

**User's choice:** Deterministic (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Sync — block until done | Memory immediately searchable | ✓ |
| Async — background embed | Faster response, delayed searchability | |

**User's choice:** Sync embedding (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — with default | ~10 second timeout, env var configurable | ✓ |
| No timeout | Wait indefinitely | |
| You decide | Claude picks | |

**User's choice:** Configurable timeout (recommended)

---

## Local Dev Experience

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — Docker Compose | pgvector/pgvector:pg17 | ✓ |
| No Docker — local Postgres | Local install | |
| Both supported | Docker + local docs | |

**User's choice:** Docker Compose (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — seed script | Sample memories for dev | ✓ |
| No seed data | Empty database | |

**User's choice:** Seed script

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — npm run dev | Starts everything in one command | ✓ |
| Separate steps | Manual docker, migrate, start | |

**User's choice:** npm run dev (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Real Postgres via Docker | Integration tests hit actual DB | ✓ |
| In-memory mock | Mock storage layer | |
| Both layers | Unit mocks + integration real | |

**User's choice:** Real Postgres via Docker (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — npm run inspect | Inspector as devDependency | ✓ |
| No — install separately | Global install | |

**User's choice:** npm run inspect (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes | .env.example with all vars | ✓ |
| Document in README only | List in docs | |

**User's choice:** .env.example (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Truncate tables between suites | Fast cleanup, schema intact | ✓ |
| Separate test DB per run | Fresh DB each run | |
| You decide | Claude picks | |

**User's choice:** Truncate tables (recommended)

---

## Concurrency & Conflicts

| Option | Description | Selected |
|--------|-------------|----------|
| Last write wins | No locking | |
| Optimistic locking | Version column, fail on conflict | ✓ |
| You decide | Claude picks | |

**User's choice:** Optimistic locking

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — fully concurrent | Independent transactions | ✓ |
| Serialize saves | Queue and process one at a time | |

**User's choice:** Fully concurrent (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| No rate limiting | Trust agents, stdio = local only | ✓ |
| Basic rate limiting | Cap requests per minute | |

**User's choice:** No rate limiting (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — idempotent | Re-archive returns success | ✓ |
| Error on re-archive | Strict, prevent double-archive | |

**User's choice:** Idempotent (recommended)

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — memory_restore | Restore with re-embedding | |
| No — archive is one-way | Only recoverable via direct DB | ✓ |
| You decide | Claude picks | |

**User's choice:** No un-archive — archive is one-way

---

## Claude's Discretion

- Error handling approach — follow MCP SDK conventions
- ID format — nanoid from tech stack
- User identity transport mechanism (per-call consistent with project_id)
- Test DB reset strategy details

## Deferred Ideas

- Comment/threading → Phase 3
- Cross-project search → Phase 2
- Tag filtering on search → Phase 2
- HTTP transport → Future phase
- RLS enforcement → Phase 3
- Un-archive/restore → Not planned
