# Phase 1: Foundation and Core Memory - Context

**Gathered:** 2026-03-23
**Status:** Ready for planning

<domain>
## Phase Boundary

MCP server with save, search, retrieve, update, archive, list, verify, and staleness detection for agent memories. Agents connect via stdio, save memories with semantic embeddings, and find them again across sessions. Memories are scoped to projects (slug-based) or users. Greenfield implementation using the tech stack defined in CLAUDE.md.

</domain>

<decisions>
## Implementation Decisions

### MCP Tool Interface

- **D-01:** CRUD-style naming with `memory_` namespace prefix. Full tool inventory: `memory_create`, `memory_get`, `memory_update`, `memory_archive`, `memory_search`, `memory_list`, `memory_verify`, `memory_list_stale` (8 tools total)
- **D-02:** Envelope response structure — `{ data: {...}, meta: { count, timing } }`. Consistent shape across all tools, room for pagination metadata.
- **D-03:** Title is optional. Auto-generate from content if not provided (first N chars or summarization).
- **D-04:** Semantic search only in Phase 1 — no tag filtering on `memory_search`. Tag filtering is available on `memory_list` instead.
- **D-05:** Error handling — Claude's discretion. Follow MCP SDK conventions for error responses.
- **D-06:** `memory_archive` accepts single ID or array of IDs for bulk operations.
- **D-07:** Both `memory_list` (paginated browse) and `memory_search` (semantic) are available.
- **D-08:** Per-call `scope` parameter on each tool — agent specifies `project` or `user` per call.
- **D-09:** `memory_update` uses partial updates (PATCH-style) — only send fields to change.
- **D-10:** Comment tool (`comment_memory`) deferred to Phase 3 (Team Collaboration).
- **D-11:** `memory_verify` included in Phase 1 — marks memory as still-accurate (updates `verified_at`).
- **D-12:** `memory_list_stale` included in Phase 1 — lists memories not verified within a configurable threshold.
- **D-13:** Tools only — no MCP resource endpoints in Phase 1.
- **D-14:** `memory_search` accepts optional `limit` parameter with default of 10.
- **D-15:** Tool descriptions include usage examples for agents, not just parameter docs.

### Memory Structure

- **D-16:** Tags structured as both: a required `type` field (predefined enum) plus optional free-form `tags` array for extra categorization.
- **D-17:** Predefined memory types enforced as PostgreSQL enum: `fact`, `decision`, `learning`, `pattern`, `preference`, `architecture`.
- **D-18:** ID format — Claude's discretion (nanoid recommended in tech stack).
- **D-19:** Embedding input: concatenate title + content for embedding generation.
- **D-20:** Soft content length limit (~4000 chars). Warn but allow longer. Truncate for embedding, store full raw text.
- **D-21:** Full lifecycle timestamps: `created_at`, `updated_at`, `verified_at`, `archived_at`.
- **D-22:** Per-memory embedding metadata stored alongside vector (model name, dimensions). Enables gradual re-embedding on provider change.
- **D-23:** Optional `source` field to track origin: `manual`, `agent-auto`, `session-review`, or custom string.
- **D-24:** Optional `session_id` field to group memories by agent session.
- **D-25:** `author` field included from Phase 1 — records who created each memory.
- **D-26:** Optional `metadata` JSONB field for extensible key-value data (file paths, URLs, etc.).
- **D-27:** Auto re-embed on content or title update. Titan is cheap ($0.02/1M tokens).
- **D-28:** Drop embedding vector on archive to save storage. Re-embedding required if un-archive is added later.
- **D-29:** No memory-to-memory linking in Phase 1. Related memories discovered via semantic search.
- **D-30:** Optimistic locking via `version` column. Update fails if version changed since read.

### Project Configuration

- **D-31:** `project_id` is a per-call parameter — agent passes it with each tool call. Single server handles multiple projects.
- **D-32:** Projects identified by human-readable slug string (e.g., `agentic-brain`). Must be unique.
- **D-33:** No default project — every call must explicitly specify `project_id`. No ambiguity.
- **D-34:** Auto-create projects on first mention — first `memory_create` with a new slug creates the project record.
- **D-35:** Database connection via `DATABASE_URL` environment variable.
- **D-36:** AWS credentials via default credential chain (env vars, IAM role, SSO).
- **D-37:** App-level filtering for project scoping in Phase 1 (WHERE clauses). RLS deferred.
- **D-38:** `user_id` required on all write operations (memory_create, memory_update, memory_archive). Ensures provenance from day one.
- **D-39:** `.env` file support via dotenv for local development.
- **D-40:** No health/status tool — if tools work, server is healthy.

### Search & List Behavior

- **D-41:** Default 10 results for `memory_search`.
- **D-42:** Configurable per-call minimum similarity threshold (default ~0.3). Results below threshold excluded.
- **D-43:** Search results return full memory object plus similarity score.
- **D-44:** Results only — no debug/embedding info exposed.
- **D-45:** `memory_list` supports `sort_by` (created_at, updated_at) and `order` (asc, desc). Default: created_at desc.
- **D-46:** Cursor-based pagination for `memory_list`.
- **D-47:** Search scoped to one project per call. Cross-project search deferred to Phase 2 (SCOP-03).
- **D-48:** `memory_list` supports filtering by `type` and `tags`.

### Transport & Deployment

- **D-49:** Stdio transport only for Phase 1. HTTP transport deferred.
- **D-50:** Entry point: `npx tsx src/server.ts`. No build step required.
- **D-51:** Graceful shutdown — handle SIGTERM/SIGINT, finish pending DB writes before exit.
- **D-52:** Startup banner logged to stderr: version, DB connection status, embedding provider.
- **D-53:** Auto-migrate on startup — run pending Drizzle migrations on first connect.

### Embedding

- **D-54:** Fail the save when embedding provider is unavailable. Return error to agent. No partial state.
- **D-55:** Mock embedding provider for development — deterministic (hash-based) vectors. Enables local dev without AWS credentials.
- **D-56:** Synchronous embedding — `memory_create` blocks until embedding is generated. Memory immediately searchable.
- **D-57:** Configurable embedding API timeout (~10 seconds default via env var).

### Local Development

- **D-58:** Docker Compose with `pgvector/pgvector:pg17` for local Postgres.
- **D-59:** Seed script with sample memories for development.
- **D-60:** `npm run dev` — starts Docker, runs migrations, launches server with `tsx watch`.
- **D-61:** Tests run against real Docker Postgres with pgvector. No mocks for storage layer.
- **D-62:** MCP Inspector as devDependency with `npm run inspect` script.
- **D-63:** `.env.example` file documenting all expected environment variables.
- **D-64:** Truncate tables between test suites for clean state.

### Concurrency

- **D-65:** Fully concurrent saves — each memory_create is an independent transaction.
- **D-66:** No rate limiting in Phase 1 (stdio = local access only).
- **D-67:** Archive is idempotent — archiving an already-archived memory returns success.
- **D-68:** No un-archive/restore tool in Phase 1 — archive is one-way.

### Claude's Discretion

- Error handling approach (D-05) — follow MCP SDK conventions
- ID format (D-18) — nanoid recommended in tech stack
- User identity mechanism (D-38 establishes user_id is required on writes; Claude decides whether per-call param or env var is the transport mechanism, consistent with project_id being per-call)
- Test DB reset strategy details (D-64)

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs or ADRs exist yet. Requirements are fully captured in decisions above and in:

### Project Documentation

- `.planning/PROJECT.md` — Project vision, constraints, key decisions
- `.planning/REQUIREMENTS.md` — Full v1 requirements with traceability matrix
- `.planning/ROADMAP.md` — Phase breakdown with success criteria

### Tech Stack

- `CLAUDE.md` §Technology Stack — Complete tech stack with versions, alternatives considered, and compatibility matrix
- `CLAUDE.md` §Embedding Dimension Strategy — 512 dimensions chosen, accuracy tradeoffs
- `CLAUDE.md` §HNSW Index Tuning — m=16, ef_construction=64 defaults
- `CLAUDE.md` §Docker Compose for Local Development — pgvector container config

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- None — greenfield project. Only CLAUDE.md exists.

### Established Patterns

- None yet. Phase 1 establishes all foundational patterns (project structure, module organization, error handling, testing).

### Integration Points

- MCP client configuration (claude_desktop_config.json or equivalent) — agents will configure this server's entry point
- Docker Compose — local Postgres with pgvector extension
- AWS Bedrock — Titan V2 embedding API calls

</code_context>

<specifics>
## Specific Ideas

- User wants verify + list_stale pulled forward from Phase 3 into Phase 1 — considers staleness detection valuable even for single-user
- User chose optimistic locking over last-write-wins — expects concurrent agent access to be a real scenario
- User explicitly chose to drop embedding vectors on archive — storage optimization over convenience
- User wants projects auto-created on first mention — zero setup friction for new projects
- User chose no default project — prefers explicitness over convenience for project identification
- User chose app-level filtering over RLS for Phase 1 — simpler to implement, RLS can come with team features

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

All scope boundaries maintained:

- Comment/threading → Phase 3
- Cross-project search → Phase 2
- Tag filtering on search → Phase 2 (ADVR-02)
- HTTP transport → Future phase
- RLS enforcement → Phase 3
- Un-archive/restore → Not planned (archive is one-way)

</deferred>

---

_Phase: 01-foundation-and-core-memory_
_Context gathered: 2026-03-23_
