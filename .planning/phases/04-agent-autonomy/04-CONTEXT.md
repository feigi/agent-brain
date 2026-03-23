# Phase 4: Agent Autonomy - Context

**Gathered:** 2026-03-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents autonomously capture insights mid-session and extract learnings at session end, with write budgets and duplicate detection as safeguards against memory bloat. Adds an MCP prompt resource for capture guidance, Claude Code hook templates, server-side session ID generation, write budget tracking, and semantic duplicate detection on memory creation.

</domain>

<decisions>
## Implementation Decisions

### System Prompt Delivery (AUTO-02)

- **D-01:** MCP prompt resource (`memory-guidance` or similar) for system prompt guidance on what patterns are worth remembering. Prompt content lives in the server codebase and is versioned with it.
- **D-02:** No auto-injection — users configure their agent (e.g., CLAUDE.md, agent settings) to invoke the prompt at session start. Documentation provides setup instructions.
- **D-03:** All memory types (`fact`, `decision`, `learning`, `pattern`, `preference`, `architecture`) are equal priority. The agent judges what's worth capturing based on context.

### Session-End Review (AUTO-03)

- **D-04:** Session-end review is agent behavior, not a server-side tool. No new `memory_session_end` tool. Agent uses existing `memory_create` with `source: 'session-review'`.
- **D-05:** Continuous capture pattern — agent saves at natural breakpoints throughout the session (after completing tasks, commits, milestones) AND does a final review when the user signals they're wrapping up.
- **D-06:** Abrupt exits lose only learnings since the last breakpoint capture. Acceptable trade-off for simplicity.

### Claude Code Hook Templates

- **D-07:** Ship ready-to-use Claude Code hook configuration templates as part of Phase 4 deliverables:
  - **Stop hook** — triggers session-end review when Claude stops responding. Solves the "how does the agent know the session ended" problem for Claude Code users.
  - **PostToolCall hook on `memory_create`** (optional) — tracks autonomous saves for client-side budget awareness/visibility.
- **D-08:** Hooks are configuration files/documentation only — no server code. Users copy into their Claude Code settings to activate.
- **D-09:** Hooks are a recommended enhancement for Claude Code users, not a requirement. Other MCP clients rely on the natural-breakpoints pattern from the prompt.

### Write Budget (AUTO-04)

- **D-10:** Server-side tracking per session_id. Server counts autonomous writes (`source: 'agent-auto'` or `source: 'session-review'`) against the budget. Manual writes (`source: 'manual'`) do not count.
- **D-11:** Configurable via env var `WRITE_BUDGET_PER_SESSION` (default: 10).
- **D-12:** Soft response, not error. `memory_create` response includes budget metadata: `{ budget: { used: N, limit: M, exceeded: boolean } }`.
- **D-13:** On budget exceeded: soft reject — memory is NOT created. Response returns `{ budget: { used: 10, limit: 10, exceeded: true }, skipped: true }` with a message. Not an MCP error — agent can still force-save by using `source: 'manual'`.

### Duplicate Detection (AUTO-05)

- **D-14:** Semantic duplicate detection on ALL `memory_create` calls (manual and autonomous). Prevents duplicates regardless of source.
- **D-15:** Configurable cosine similarity threshold via env var `DUPLICATE_THRESHOLD` (default: 0.90).
- **D-16:** Scope-aware checking:
  - **Project-scoped memory** — checked against existing project memories only.
  - **User-scoped memory** — checked against existing user memories AND project memories. If a match is found in project scope, response communicates "this already exists as shared knowledge — no need for a private copy."
- **D-17:** On duplicate detected: soft reject — memory NOT saved. Response includes the existing duplicate: `{ duplicate: true, existing: { id, title, relevance } }`. Agent can update the existing memory instead.

### Session ID Lifecycle

- **D-18:** Server generates session_id on `memory_session_start` call. Returned in the response. Server is the source of truth for session IDs.
- **D-19:** `memory_create` requires session_id for autonomous writes (`source: 'agent-auto'` or `source: 'session-review'`). Server rejects autonomous writes without a session_id.
- **D-20:** `memory_create` with `source: 'manual'` does not require session_id. Optional — if provided, the save is associated with the session but does not count toward budget.
- **D-21:** Sessions do not expire. No TTL on session_id. Budget is lifetime per session_id.

### Claude's Discretion

- MCP prompt resource name and content structure
- Exact hook template content and configuration format
- How budget metadata is structured in the response envelope (fits within existing `meta` pattern)
- How duplicate check integrates with the embedding flow (check before or after generating embedding for the new memory)
- Session ID format (nanoid recommended, consistent with existing ID generation)
- Error message wording for missing session_id on autonomous writes

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Prior Phase Decisions
- `.planning/phases/01-foundation-and-core-memory/01-CONTEXT.md` — D-23 (source field values), D-24 (session_id field), D-30 (optimistic locking)
- `.planning/phases/02-retrieval-quality-and-session-lifecycle/02-CONTEXT.md` — D-17 (session management deferred to Phase 4)
- `.planning/phases/03-team-collaboration/03-CONTEXT.md` — D-28 (session tracking table), D-29/D-30 (team_activity in session_start response)

### Existing Implementation
- `src/tools/memory-session-start.ts` — current session_start tool (must be extended to return session_id)
- `src/tools/memory-create.ts` — current create tool (must add budget tracking, dedup, session_id validation)
- `src/services/memory-service.ts` — service layer (budget and dedup logic goes here)
- `src/repositories/types.ts` — repository interfaces (session tracking repo already exists)
- `src/utils/scoring.ts` — existing relevance scoring (dedup similarity check can reuse embedding infrastructure)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `EmbeddingProvider` interface and Titan implementation — reuse for dedup similarity computation
- `computeRelevance` and cosine distance infrastructure — reuse for duplicate threshold comparison
- `SessionTrackingRepository` — already tracks last_session_at per user/project, extend for session_id and budget counters
- `source` field on memories — already supports `agent-auto`, `session-review`, `manual` values
- `session_id` field on memories — already exists as optional column

### Established Patterns
- Envelope response format: `{ data, meta: { count, timing } }` — budget metadata fits in `meta`
- Soft reject pattern: return structured response (not MCP error) with skip indicators
- Slug validation: `slugSchema` in `src/utils/validation.ts` for input validation
- Tool registration pattern in `src/tools/` — one file per tool with `register*` function

### Integration Points
- `memory_session_start` tool — add session_id generation and return
- `memory_create` tool/service — add dedup check, budget check, session_id validation
- Server entry point (`src/server.ts`) — register new MCP prompt resource
- Config (`src/config.ts`) — add `WRITE_BUDGET_PER_SESSION` and `DUPLICATE_THRESHOLD` env vars

</code_context>

<specifics>
## Specific Ideas

- User wants to test what works best between prompt-only guidance and Claude Code hooks — both should ship so the user can compare effectiveness
- Asymmetric dedup scope (user memories check against project too) is intentional — "already exists as shared knowledge" message helps agents avoid redundant private copies
- Budget soft-reject with manual override preserves user agency — agents are limited, humans are not

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-agent-autonomy*
*Context gathered: 2026-03-23*
