# Phase 2: Retrieval Quality and Session Lifecycle - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-23
**Phase:** 02-retrieval-quality-and-session-lifecycle
**Areas discussed:** Relevance scoring, Cross-scope search, Session auto-load

---

## Relevance Scoring

### Recency Weight

| Option                | Description                                                                                                    | Selected |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| Light recency boost   | Similarity dominates (~80%), recency gives gentle nudge (~20%). Exponential decay over configurable half-life. | ✓        |
| Equal weight blend    | 50/50 similarity and recency. Recent memories get significant priority.                                        |          |
| Configurable per-call | Agent passes recency_weight parameter (0.0–1.0) on each search call.                                           |          |
| You decide            | Claude picks based on codebase and research literature.                                                        |          |

**User's choice:** Light recency boost
**Notes:** None

### Recency Half-Life

| Option                   | Description                                                        | Selected |
| ------------------------ | ------------------------------------------------------------------ | -------- |
| 7 days                   | Good for active development.                                       |          |
| 30 days                  | Slower decay, treats 2-week-old memory nearly same as yesterday's. |          |
| Configurable via env var | Default to 7 days but allow override.                              |          |

**User's choice:** 14 days default (custom input)
**Notes:** User chose a custom value between the offered options — 14 days as a middle ground.

### Score Output

| Option         | Description                                                       | Selected |
| -------------- | ----------------------------------------------------------------- | -------- |
| Composite only | Single `relevance` field replaces `similarity`. Aligns with D-44. | ✓        |
| Both scores    | Return `relevance` (composite) and `similarity` (raw cosine).     |          |
| You decide     | Claude picks based on envelope structure.                         |          |

**User's choice:** Composite only
**Notes:** None

### Verification Boost

| Option           | Description                               | Selected |
| ---------------- | ----------------------------------------- | -------- |
| Yes, small boost | Verified memories get ~5% relevance bump. | ✓        |
| No boost         | Verification is informational only.       |          |
| You decide       | Claude decides based on scoring formula.  |          |

**User's choice:** Yes, small boost
**Notes:** None

### Configuration Level

| Option             | Description                                                 | Selected |
| ------------------ | ----------------------------------------------------------- | -------- |
| Server-level only  | Env var RECENCY_HALF_LIFE_DAYS=14. Simple search interface. | ✓        |
| Per-call parameter | Add optional recency_half_life to memory_search.            |          |
| Both               | Env var sets default, per-call overrides.                   |          |

**User's choice:** Server-level only
**Notes:** None

### Compute Location

| Option            | Description                                                | Selected |
| ----------------- | ---------------------------------------------------------- | -------- |
| Application layer | Fetch top candidates by similarity, re-rank in TypeScript. | ✓        |
| SQL-side          | Compute full composite score in Postgres query.            |          |
| You decide        | Claude picks based on tradeoffs.                           |          |

**User's choice:** Application layer
**Notes:** Matches existing pattern of app-layer filtering from Phase 1.

### Field Naming

| Option                         | Description                                           | Selected |
| ------------------------------ | ----------------------------------------------------- | -------- |
| Rename to relevance            | Breaking change, but no external users yet.           | ✓        |
| Add relevance, keep similarity | Non-breaking but contradicts composite-only decision. |          |

**User's choice:** Rename to relevance
**Notes:** None

---

## Cross-Scope Search

### Interface Design

| Option                  | Description                                                               | Selected |
| ----------------------- | ------------------------------------------------------------------------- | -------- |
| Add 'both' scope option | Extend existing scope: 'project' \| 'user' \| 'both'. Minimal API change. | ✓        |
| New dedicated tool      | Add memory_search_unified alongside existing.                             |          |
| Always search both      | Remove scope parameter, always search both when user_id provided.         |          |

**User's choice:** Add 'both' scope option
**Notes:** None

### Merge Strategy

| Option                    | Description                                          | Selected |
| ------------------------- | ---------------------------------------------------- | -------- |
| Single query with OR      | One SQL query with OR conditions. Single round-trip. | ✓        |
| Two queries, merge in app | Run separately, merge and re-rank in TypeScript.     |          |
| You decide                | Claude picks for repository pattern.                 |          |

**User's choice:** Single query with OR
**Notes:** None

### Scope Indicator

| Option | Description                                                        | Selected |
| ------ | ------------------------------------------------------------------ | -------- |
| Yes    | Each result's existing scope field shows origin. No schema change. | ✓        |
| No     | Agents treat all results the same.                                 |          |

**User's choice:** Yes
**Notes:** Already present on Memory object, just needs to be visible.

### User ID Requirement

| Option                          | Description                                        | Selected |
| ------------------------------- | -------------------------------------------------- | -------- |
| Required for 'both'             | Must provide both project_id and user_id.          | ✓        |
| Optional, project-only fallback | Silently return project-only if user_id omitted.   |          |
| Required, error if missing      | Strict error if user_id missing with scope='both'. |          |

**User's choice:** Required for 'both'
**Notes:** None

---

## Session Auto-Load

### Interface

| Option                        | Description                                  | Selected |
| ----------------------------- | -------------------------------------------- | -------- |
| New memory_session_start tool | Dedicated tool agents call at session start. | ✓        |
| MCP resource endpoint         | Expose as MCP resource.                      |          |
| Enhance memory_search         | No new tool, agents use existing search.     |          |

**User's choice:** New memory_session_start tool
**Notes:** None

### Context Parameter

| Option                   | Description                                                   | Selected |
| ------------------------ | ------------------------------------------------------------- | -------- |
| Optional context string  | Brief description of work. If omitted, recency-based ranking. | ✓        |
| Required context string  | Must describe task. Forces intentional loading.               |          |
| No context, recency only | Always return most recent.                                    |          |

**User's choice:** Optional context string
**Notes:** None

### Default Limit

| Option                   | Description                            | Selected |
| ------------------------ | -------------------------------------- | -------- |
| 10 memories              | Consistent with memory_search default. | ✓        |
| 5 memories               | Leaner, only most relevant.            |          |
| 20 memories              | More comprehensive load.               |          |
| Configurable via env var | Default 10, override with env var.     |          |

**User's choice:** 10 memories
**Notes:** None

### Session Scope

| Option                      | Description                                               | Selected |
| --------------------------- | --------------------------------------------------------- | -------- |
| Always search both          | Always include project + user memories. Requires user_id. | ✓        |
| Scope parameter like search | Same options as memory_search.                            |          |
| You decide                  | Claude picks for agent ergonomics.                        |          |

**User's choice:** Always search both
**Notes:** None

### No-Context Ranking

| Option                              | Description                                                           | Selected |
| ----------------------------------- | --------------------------------------------------------------------- | -------- |
| Recency-weighted                    | Most recent memories using composite scoring with recency dominating. | ✓        |
| Most recently verified              | Prioritize verified memories.                                         |          |
| Mix of recent + frequently accessed | Blend recent with most-searched. Would need access tracking.          |          |

**User's choice:** Recency-weighted
**Notes:** None

### Session Management

| Option                | Description                                                                    | Selected |
| --------------------- | ------------------------------------------------------------------------------ | -------- |
| Just return memories  | No session tracking. Smart query only. Session management deferred to Phase 4. | ✓        |
| Create session record | Create sessions table, generate session_id.                                    |          |
| You decide            | Claude decides based on Phase 4 needs.                                         |          |

**User's choice:** Just return memories
**Notes:** None

### Response Format

| Option               | Description                                                           | Selected |
| -------------------- | --------------------------------------------------------------------- | -------- |
| Same envelope format | { data: MemoryWithRelevance[], meta: { count, timing } }. Consistent. | ✓        |
| Enriched format      | Add 'reason' metadata for each memory.                                |          |
| Grouped by scope     | Return { project: [...], user: [...] }. Breaks envelope consistency.  |          |

**User's choice:** Same envelope format
**Notes:** None

---

## Claude's Discretion

- Exact weighting constants for composite formula
- Verification boost implementation detail
- Over-fetch factor for re-ranking
- Fallback behavior for session_start with no context and no memories

## Deferred Ideas

- Session tracking/management → Phase 4
- Access frequency tracking → Not planned
- Enriched response with "reason for inclusion" → Not planned
- Grouped-by-scope response format → Rejected
