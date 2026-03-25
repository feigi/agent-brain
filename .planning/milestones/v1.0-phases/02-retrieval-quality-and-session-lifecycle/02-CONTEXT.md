# Phase 2: Retrieval Quality and Session Lifecycle - Context

**Gathered:** 2026-03-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Enhanced search ranking with composite relevance scoring (semantic similarity + recency weighting + verification boost) and a new `memory_session_start` tool for auto-loading relevant memories at session start. Also adds cross-scope search (`scope: 'both'`) to `memory_search` so agents can query project and user memories in a single call.

</domain>

<decisions>
## Implementation Decisions

### Relevance Scoring

- **D-01:** Composite relevance score combining semantic similarity (~80%) with recency boost (~20%). Similarity dominates — a great old memory still beats a mediocre recent one.
- **D-02:** Exponential recency decay with 14-day half-life. After 14 days, the recency component drops to 50% of its maximum contribution.
- **D-03:** Verified memories get a small relevance boost (~5%). Rewards team curation without dominating ranking.
- **D-04:** Scoring computed in the application layer (TypeScript), not SQL. Fetch top candidates by similarity from Postgres, then re-rank with composite score. Matches existing pattern (D-42 from Phase 1: min_similarity filtered in app layer).
- **D-05:** Single `relevance` field replaces `similarity` in search results. Breaking rename from Phase 1's `similarity` field — acceptable since no external consumers yet.
- **D-06:** `MemoryWithScore` type renamed/updated: `similarity` field becomes `relevance`.
- **D-07:** Recency half-life configurable at server level only (env var `RECENCY_HALF_LIFE_DAYS=14`). Not exposed as a per-call parameter — keeps the search tool interface simple for agents.

### Cross-Scope Search

- **D-08:** Add `'both'` as a third option to the existing `scope` parameter on `memory_search`: `'project' | 'user' | 'both'`.
- **D-09:** `user_id` required when `scope='both'`. Must provide both `project_id` and `user_id` to search across scopes.
- **D-10:** Single SQL query with OR conditions: `WHERE (project_id = X) OR (author = Y AND scope = 'user')`. One round-trip, naturally interleaved by relevance score.
- **D-11:** Scope indicator preserved in results — each result's existing `scope` field ('project' or 'user') tells agents which scope it came from. No schema change needed.

### Session Auto-Load

- **D-12:** New `memory_session_start` MCP tool. Agents call it at session start to load relevant memories.
- **D-13:** Takes `project_id` (required), `user_id` (required), and optional `context` string (what the agent is working on).
- **D-14:** When `context` is provided, used as semantic query to rank memories by relevance. When omitted, returns memories ranked by recency (most recent first, using composite scoring with recency dominating).
- **D-15:** Always searches both project and user scopes — no scope parameter. This is the primary cross-scope use case.
- **D-16:** Default limit: 10 memories. Consistent with `memory_search` default (D-41 from Phase 1). Configurable per-call via `limit` parameter.
- **D-17:** No session management or session tracking in Phase 2. The tool is a smart query, not a session manager. Session records deferred to Phase 4 (Agent Autonomy).
- **D-18:** Response uses the same envelope format as other tools: `{ data: MemoryWithRelevance[], meta: { count, timing } }`. Uses the new `relevance` field from composite scoring.

### Claude's Discretion

- Exact weighting constants for the composite formula (80/20 similarity/recency split is the target, Claude fine-tunes the math)
- Verification boost implementation detail (how +5% is applied in the formula)
- Over-fetch factor for re-ranking (how many candidates to fetch from Postgres before app-layer re-ranking)
- Fallback behavior for `memory_session_start` when no context provided and no recent memories exist (empty result vs informational message)

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Documentation

- `.planning/PROJECT.md` — Project vision, constraints, key decisions
- `.planning/REQUIREMENTS.md` — Full v1 requirements with traceability matrix (SCOP-03, RETR-01 through RETR-05)
- `.planning/ROADMAP.md` — Phase breakdown with success criteria

### Phase 1 Context (Prior Decisions)

- `.planning/phases/01-foundation-and-core-memory/01-CONTEXT.md` — All Phase 1 decisions (D-01 through D-68). Particularly relevant: D-02 (envelope format), D-41 (default 10 results), D-42 (min_similarity 0.3), D-43 (full memory + score), D-44 (no debug info), D-47 (single-scope search)

### Tech Stack

- `CLAUDE.md` §Technology Stack — Complete tech stack with versions, alternatives considered, and compatibility matrix
- `CLAUDE.md` §Embedding Dimension Strategy — 512 dimensions, accuracy tradeoffs

### Existing Implementation

- `src/repositories/types.ts` — `SearchOptions` interface to extend for cross-scope
- `src/repositories/memory-repository.ts` — Current search implementation (cosine distance, app-layer filtering)
- `src/services/memory-service.ts` — Service layer where composite scoring will be added
- `src/types/memory.ts` — `MemoryWithScore` type to rename/update
- `src/tools/memory-search.ts` — Search tool to extend with 'both' scope
- `src/config.ts` — Server configuration where env vars are loaded

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `MemoryWithScore` type — extends Memory with score field. Needs rename: `similarity` → `relevance`
- `SearchOptions` interface — clean and extensible, add `scope: 'both'` variant
- `cosineDistance` from drizzle-orm — already used in repository search method
- `toolResponse` and `withErrorHandling` — tool utilities for new session_start tool
- `memoryColumns` — explicit column selection, reusable in new queries
- Envelope response structure — consistent `{ data, meta }` pattern across all tools

### Established Patterns

- App-layer filtering after DB query (min_similarity pattern from D-42) — composite scoring follows same pattern
- Repository interface abstraction — new search behavior stays behind `MemoryRepository` interface
- Tool registration pattern — `registerMemorySearch` style, used for new `memory_session_start` tool
- Zod schema validation on tool inputs — `.catch()` for defensive MCP client handling
- All logging to stderr via `logger` utility

### Integration Points

- `src/tools/index.ts` — register new `memory_session_start` tool
- `src/services/memory-service.ts` — add composite scoring logic and session-start method
- `src/repositories/types.ts` — extend `SearchOptions` for cross-scope
- `src/repositories/memory-repository.ts` — extend search SQL for OR-based cross-scope
- `src/config.ts` — add `RECENCY_HALF_LIFE_DAYS` env var

</code_context>

<specifics>
## Specific Ideas

- User chose 14-day half-life (custom input, not from options) — values a balance between active dev cadence and long-lived reference material
- User explicitly wants breaking rename from `similarity` to `relevance` — no backwards compat needed since Phase 1 just shipped with no external consumers
- Session auto-load is intentionally NOT a session manager — Phase 4 owns session lifecycle
- Cross-scope search uses simple OR in SQL, not two-query merge — keeps implementation simple

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

All scope boundaries maintained:

- Session tracking/management → Phase 4
- Access frequency tracking → Not planned (would require new infrastructure)
- Enriched response with "reason for inclusion" → Not planned (keeps responses simple)
- Grouped-by-scope response format → Rejected in favor of flat list with scope field

</deferred>

---

_Phase: 02-retrieval-quality-and-session-lifecycle_
_Context gathered: 2026-03-23_
