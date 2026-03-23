# Phase 2: Retrieval Quality and Session Lifecycle - Research

**Researched:** 2026-03-23
**Domain:** Composite relevance scoring, cross-scope search, MCP tool registration
**Confidence:** HIGH

## Summary

Phase 2 adds three capabilities to the existing memory system: (1) composite relevance scoring that re-ranks search results by combining semantic similarity with recency decay and verification boost, (2) cross-scope search via a `scope: 'both'` option on `memory_search`, and (3) a new `memory_session_start` MCP tool that auto-loads relevant memories at session start.

All three features build directly on existing infrastructure. The composite scoring is pure application-layer math applied after the existing pgvector cosine distance query. Cross-scope search extends the existing SQL WHERE clause with an OR condition using Drizzle's `or()` operator (already imported). The new tool follows the established `registerMemory*` pattern with `withErrorHandling` and `toolResponse` utilities.

**Primary recommendation:** Implement scoring as a pure function in the service layer (no DB changes), extend `SearchOptions` and repository for cross-scope queries, and add the `memory_session_start` tool following the existing tool registration pattern. No schema migrations are needed.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Composite relevance score combining semantic similarity (~80%) with recency boost (~20%). Similarity dominates -- a great old memory still beats a mediocre recent one.
- **D-02:** Exponential recency decay with 14-day half-life. After 14 days, the recency component drops to 50% of its maximum contribution.
- **D-03:** Verified memories get a small relevance boost (~5%). Rewards team curation without dominating ranking.
- **D-04:** Scoring computed in the application layer (TypeScript), not SQL. Fetch top candidates by similarity from Postgres, then re-rank with composite score.
- **D-05:** Single `relevance` field replaces `similarity` in search results. Breaking rename from Phase 1's `similarity` field.
- **D-06:** `MemoryWithScore` type renamed/updated: `similarity` field becomes `relevance`.
- **D-07:** Recency half-life configurable at server level only (env var `RECENCY_HALF_LIFE_DAYS=14`). Not exposed as a per-call parameter.
- **D-08:** Add `'both'` as a third option to the existing `scope` parameter on `memory_search`: `'project' | 'user' | 'both'`.
- **D-09:** `user_id` required when `scope='both'`. Must provide both `project_id` and `user_id` to search across scopes.
- **D-10:** Single SQL query with OR conditions: `WHERE (project_id = X) OR (author = Y AND scope = 'user')`. One round-trip.
- **D-11:** Scope indicator preserved in results -- each result's existing `scope` field tells agents which scope it came from.
- **D-12:** New `memory_session_start` MCP tool.
- **D-13:** Takes `project_id` (required), `user_id` (required), and optional `context` string.
- **D-14:** When `context` is provided, used as semantic query. When omitted, returns memories ranked by recency.
- **D-15:** Always searches both project and user scopes -- no scope parameter.
- **D-16:** Default limit: 10 memories. Configurable per-call via `limit` parameter.
- **D-17:** No session management or session tracking in Phase 2. The tool is a smart query, not a session manager.
- **D-18:** Response uses the same envelope format as other tools: `{ data: MemoryWithRelevance[], meta: { count, timing } }`.

### Claude's Discretion
- Exact weighting constants for the composite formula (80/20 similarity/recency split is the target, Claude fine-tunes the math)
- Verification boost implementation detail (how +5% is applied in the formula)
- Over-fetch factor for re-ranking (how many candidates to fetch from Postgres before app-layer re-ranking)
- Fallback behavior for `memory_session_start` when no context provided and no recent memories exist (empty result vs informational message)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.

All scope boundaries maintained:
- Session tracking/management deferred to Phase 4
- Access frequency tracking -- not planned
- Enriched response with "reason for inclusion" -- not planned
- Grouped-by-scope response format -- rejected in favor of flat list with scope field
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCOP-03 | Agent can search both project and user memories in a single query | Cross-scope search via `scope: 'both'` using Drizzle `or()` operator in WHERE clause (D-08, D-09, D-10) |
| RETR-01 | Semantic search returns memories ranked by vector similarity | Already implemented in Phase 1 via cosine distance; Phase 2 upgrades ranking to composite relevance score |
| RETR-02 | Relevance scoring combines semantic similarity with recency weighting | Composite scoring formula with exponential decay (D-01, D-02, D-03, D-04) -- pure TypeScript in service layer |
| RETR-03 | Search results include relevance score, creation date, author, and tags | Rename `similarity` to `relevance` in `MemoryWithScore` type (D-05, D-06); creation date, author, tags already in Memory type |
| RETR-04 | Agent can auto-load relevant memories at session start based on project context | New `memory_session_start` MCP tool (D-12 through D-18) -- uses composite scoring internally |
| RETR-05 | Session-start loading returns top-N most relevant memories within a configurable limit | `limit` parameter on `memory_session_start`, default 10 (D-16) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Protocol:** MCP server -- primary interface, stdio transport
- **Logging:** All output to stderr via `logger` utility (never console.log in stdio servers)
- **ORM:** Drizzle ORM 0.45.x with drizzle-kit 0.31.x -- no 1.0 beta
- **Testing:** Vitest 4.1.x -- TypeScript-native, ESM-first
- **Validation:** Zod 4.x for tool input schemas; use `.catch()` for optional params
- **IDs:** nanoid(21) for all generated IDs
- **Response format:** Envelope pattern `{ data, meta: { count?, timing?, cursor?, has_more? } }`
- **No LangChain, no Prisma, no console.log in MCP servers**
- **Vector dimensions:** 512, cosine similarity via pgvector
- **Tool patterns:** `withErrorHandling()` wrapper, `toolResponse()` for envelope serialization

## Standard Stack

No new dependencies required. Phase 2 uses only libraries already installed in Phase 1.

### Core (Already Installed)
| Library | Version | Purpose | Phase 2 Usage |
|---------|---------|---------|---------------|
| drizzle-orm | 0.45.x | ORM / query builder | Extend search query with `or()` for cross-scope; `cosineDistance()` unchanged |
| @modelcontextprotocol/sdk | ^1.27.1 | MCP server framework | Register new `memory_session_start` tool |
| zod | ^4.3.6 | Schema validation | Input schema for new tool |
| vitest | ^4.1.0 | Testing | Unit tests for scoring, integration tests for cross-scope and session-start |

### No New Dependencies
Phase 2 is purely application-layer logic: a scoring function, a query extension, and a new MCP tool registration. Zero new npm packages.

## Architecture Patterns

### Files to Modify
```
src/
├── config.ts                          # Add RECENCY_HALF_LIFE_DAYS env var
├── types/
│   └── memory.ts                      # Rename MemoryWithScore.similarity -> relevance
├── repositories/
│   ├── types.ts                       # Extend SearchOptions scope to include 'both'
│   └── memory-repository.ts           # Add OR condition for cross-scope search
├── services/
│   └── memory-service.ts              # Add scoring logic, sessionStart method
├── tools/
│   ├── index.ts                       # Register memory_session_start
│   ├── memory-search.ts               # Add 'both' to scope enum
│   └── memory-session-start.ts        # NEW: session start tool
└── utils/
    └── scoring.ts                     # NEW: pure scoring functions
```

### Pattern 1: Composite Relevance Scoring (Pure Function)

**What:** A pure function that takes a memory with raw similarity score and computes a composite relevance score combining similarity, recency, and verification status.

**When to use:** After fetching candidates from the database via cosine distance, before returning results to the caller.

**Formula:**

```typescript
// Exponential decay: recencyWeight = 0.5 ^ (ageInDays / halfLifeDays)
// Composite: relevance = (SIMILARITY_WEIGHT * similarity) + (RECENCY_WEIGHT * recencyDecay) + verificationBoost

// Constants (Claude's Discretion -- fine-tuned from 80/20 target)
const SIMILARITY_WEIGHT = 0.80;
const RECENCY_WEIGHT = 0.15;    // Leave room for verification boost within the ~20% non-similarity budget
const VERIFICATION_BOOST = 0.05; // Applied as flat bonus when verified_at is set

function computeRelevance(
  similarity: number,          // 0-1 from cosine distance
  createdAt: Date,
  verifiedAt: Date | null,
  halfLifeDays: number,
  now: Date = new Date(),
): number {
  // Recency: exponential decay with configurable half-life
  const ageMs = now.getTime() - createdAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyDecay = Math.pow(0.5, ageDays / halfLifeDays);

  // Composite score
  let relevance = (SIMILARITY_WEIGHT * similarity) + (RECENCY_WEIGHT * recencyDecay);

  // Verification boost: flat addition when memory has been verified
  if (verifiedAt !== null) {
    relevance += VERIFICATION_BOOST;
  }

  // Clamp to [0, 1]
  return Math.min(1, Math.max(0, relevance));
}
```

**Key design decisions:**
- **0.80 / 0.15 / 0.05 split:** The 80% target for similarity is preserved. The remaining 20% is split between recency (15%) and verification (5%). This means a perfectly matching old memory (similarity=1.0, age=infinity) scores 0.80, while a perfectly matching brand-new verified memory scores 1.0.
- **Flat verification boost (not multiplicative):** A verified memory always gets +0.05 regardless of other factors. This is simpler than multiplicative and ensures the boost is predictable.
- **Clamping to [0, 1]:** Prevents edge cases where verification boost could push above 1.0.
- **`createdAt` not `updatedAt`:** Recency is based on when the memory was created, not when it was last modified. An updated memory's content freshness is captured by re-embedding, not by date.

### Pattern 2: Over-Fetch and Re-Rank

**What:** Fetch more candidates from the database than the caller requested, then re-rank with composite scoring and return the top N.

**When to use:** Always for search operations that use composite scoring. The cosine distance ordering from Postgres may not match the composite relevance ordering after recency and verification are applied.

**Example:**

```typescript
// Over-fetch factor: 3x the requested limit
// This ensures we have enough candidates to re-rank properly.
// For limit=10, we fetch 30 from Postgres by similarity, then re-rank and return top 10.
const OVER_FETCH_FACTOR = 3;

async search(query: string, ...): Promise<Envelope<MemoryWithRelevance[]>> {
  const overFetchLimit = (limit ?? 10) * OVER_FETCH_FACTOR;

  // Step 1: Fetch candidates by raw cosine similarity
  const candidates = await this.memoryRepo.search({
    embedding,
    project_id,
    scope,
    user_id,
    limit: overFetchLimit,
    min_similarity,
  });

  // Step 2: Re-rank with composite scoring
  const scored = candidates.map(candidate => ({
    ...candidate,
    relevance: computeRelevance(
      candidate.similarity,
      candidate.created_at,
      candidate.verified_at,
      this.config.recencyHalfLifeDays,
    ),
  }));

  // Step 3: Sort by relevance descending, take top N
  scored.sort((a, b) => b.relevance - a.relevance);
  const results = scored.slice(0, limit ?? 10);

  // Step 4: Remove raw similarity, return relevance only (D-05)
  return results.map(({ similarity, ...rest }) => rest);
}
```

**Why 3x over-fetch:** At 3x, even if recency significantly re-orders the bottom third of results, we have enough candidates to fill the requested limit with the best composite scores. Going higher than 3x wastes database IO; going lower risks missing good results that recency would promote. This is a reasonable starting point.

### Pattern 3: Cross-Scope SQL with Drizzle OR

**What:** A single database query that fetches memories from both project and user scope using OR conditions.

**When to use:** When `scope === 'both'` in SearchOptions.

**Example:**

```typescript
// In memory-repository.ts search method:
if (options.scope === "project") {
  conditions.push(eq(memories.project_id, options.project_id));
} else if (options.scope === "user") {
  if (!options.user_id) throw new Error("user_id is required for user-scoped search");
  conditions.push(eq(memories.author, options.user_id));
  conditions.push(eq(memories.scope, "user"));
} else {
  // scope === 'both' (D-10)
  if (!options.user_id) throw new Error("user_id is required for cross-scope search");
  conditions.push(
    or(
      eq(memories.project_id, options.project_id),
      and(eq(memories.author, options.user_id), eq(memories.scope, "user")),
    )!,
  );
}
```

**Notes:**
- Drizzle's `or()` is already imported in `memory-repository.ts` (used in cursor pagination).
- The `!` non-null assertion on `or()` is needed because Drizzle's `or()` can return `undefined` when given no arguments. With two arguments it is always defined.
- This matches the existing pattern where `and()` is used with the conditions array.

### Pattern 4: Session Start Tool Registration

**What:** New `memory_session_start` MCP tool following the established `registerMemory*` pattern.

**Example:**

```typescript
// src/tools/memory-session-start.ts
export function registerMemorySessionStart(server: McpServer, memoryService: MemoryService): void {
  server.registerTool(
    "memory_session_start",
    {
      description:
        'Load relevant memories at session start. Searches both project and user scopes. '
        + 'Example: memory_session_start({ project_id: "my-project", user_id: "alice" })',
      inputSchema: {
        project_id: z.string().describe("Project slug"),
        user_id: z.string().describe("User identifier"),
        context: z.string().optional().describe("What the agent is working on (used for relevance ranking)"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max memories to return (default 10)"),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.sessionStart(
          params.project_id,
          params.user_id,
          params.context,
          params.limit,
        );
        return toolResponse(result);
      });
    },
  );
}
```

### Pattern 5: Recency-Only Ranking (No Context)

**What:** When `memory_session_start` is called without a `context` string, there is no semantic query to embed. Instead, fetch recent memories and rank by recency-dominated composite score.

**How:** Use the existing `list` functionality to fetch recent memories from both scopes, sorted by `created_at DESC`, then apply composite scoring with recency dominating (since similarity is not available).

**Alternative approach (recommended):** Use a zero-vector or skip embedding entirely. Fetch recent memories by recency from the database directly (not via vector search), then apply a recency-only score.

```typescript
async sessionStart(
  projectId: string,
  userId: string,
  context?: string,
  limit: number = 10,
): Promise<Envelope<MemoryWithRelevance[]>> {
  if (context) {
    // With context: embed and search semantically with composite scoring
    return this.search(context, projectId, 'both', userId, limit, 0.0);
    // min_similarity=0.0 because session start should be permissive
  } else {
    // Without context: fetch recent memories, rank by recency
    // Use a dedicated repository method or list with both scopes
    // Apply recency-only scoring (similarity component = 0 or neutral)
  }
}
```

**Recommended no-context approach:**
- Fetch recent memories from both scopes using a list-style query (not vector search)
- Apply composite scoring where similarity = 1.0 (neutral) so recency and verification dominate
- This avoids needing an embedding call and returns genuinely recent content

### Anti-Patterns to Avoid

- **Computing scores in SQL:** Decision D-04 explicitly requires app-layer scoring. Do not try to compute exponential decay in a Postgres query. The cosine distance computation stays in Postgres; everything else is TypeScript.
- **Using `updatedAt` for recency:** Recency is about when the knowledge was created, not when it was last edited. An updated-but-old memory is not "recent."
- **Multiplicative verification boost:** `similarity * 1.05` is wrong because it makes the boost proportional to similarity. A low-similarity verified memory gets almost no boost. Use additive instead.
- **Exposing raw similarity alongside relevance:** D-05 is explicit -- return `relevance` only, not both fields. The raw similarity is an implementation detail.
- **Session tracking:** Phase 2 does NOT create session records. The `memory_session_start` tool is a smart query, not a session lifecycle event.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Exponential decay | Custom decay curve fitting | Standard half-life formula: `Math.pow(0.5, age/halfLife)` | Well-established math; any deviation introduces hard-to-debug ranking anomalies |
| Cross-scope OR queries | Two separate queries merged in JS | Drizzle's `or()` in a single query (D-10) | One DB round-trip, naturally interleaved by score, no merge sort needed |
| Tool registration | Custom MCP handler | `server.registerTool()` with `withErrorHandling`/`toolResponse` | Consistent with all 8 existing tools; error handling is already correct |
| Score clamping | Manual if/else | `Math.min(1, Math.max(0, score))` | Standard pattern; prevents edge cases without custom logic |

## Common Pitfalls

### Pitfall 1: Over-Fetch Limit Too Low
**What goes wrong:** With composite scoring, a memory ranked #15 by pure similarity might rank #5 after recency boost. If you only fetch 10 from the DB, you miss it.
**Why it happens:** Pure cosine distance ordering doesn't account for recency or verification.
**How to avoid:** Use at least 3x over-fetch factor. For limit=10, fetch 30 candidates.
**Warning signs:** Users report that very recent, relevant memories don't appear in results despite being semantically close.

### Pitfall 2: Breaking Change to `similarity` Field
**What goes wrong:** Tests and any code referencing `similarity` break after renaming to `relevance`.
**Why it happens:** D-05 and D-06 require this rename, but existing test assertions check `similarity`.
**How to avoid:** Update ALL references: `MemoryWithScore` type, repository return values, service layer mapping, test assertions. Search the entire codebase for `similarity` after the rename.
**Warning signs:** TypeScript compilation errors (which is good -- the type system catches this).

### Pitfall 3: Forgetting `!` on `or()` Return
**What goes wrong:** TypeScript error: `SQL | undefined` is not assignable to `SQL`.
**Why it happens:** Drizzle's `or()` signature returns `SQL | undefined` because it accepts rest args and could receive zero arguments.
**How to avoid:** Always use `or(condition1, condition2)!` with the non-null assertion. This is the established pattern in the codebase (see cursor pagination in `memory-repository.ts` line 228-240).
**Warning signs:** TypeScript compilation error.

### Pitfall 4: Embedding Call for No-Context Session Start
**What goes wrong:** `memory_session_start` called without `context` attempts to embed an empty string, producing garbage similarity scores.
**Why it happens:** Code path doesn't differentiate between "has context" and "no context."
**How to avoid:** When `context` is not provided, use a non-embedding query path (fetch by recency, not by vector similarity).
**Warning signs:** Session start returns random-seeming results when no context is provided.

### Pitfall 5: `and()` Inside `or()` Scope Issue
**What goes wrong:** The cross-scope query leaks memories across projects because the OR condition isn't properly scoped.
**Why it happens:** `WHERE (project_id = X) OR (author = Y AND scope = 'user')` without the `isNull(archived_at)` being applied to BOTH branches.
**How to avoid:** The `isNull(archived_at)` condition is pushed to the `conditions` array BEFORE the scope-specific condition, so it's AND-ed with the entire expression. Verify: `WHERE archived_at IS NULL AND ((project_id = X) OR (author = Y AND scope = 'user'))`.
**Warning signs:** Archived memories appearing in cross-scope search results.

### Pitfall 6: Type Rename Cascading to Repository Interface
**What goes wrong:** `MemoryRepository.search()` returns `MemoryWithScore[]` which has a `similarity` field. After rename to `relevance`, the repository still returns raw cosine similarity, not composite relevance.
**Why it happens:** The repository should return raw similarity; the service layer computes composite relevance.
**How to avoid:** Keep an internal type for repository returns (raw similarity) and a separate type for service/tool returns (composite relevance). Or: rename the field at the boundary where scoring is applied, not in the repository.
**Warning signs:** Confusion about whether a score is raw similarity or composite relevance.

## Code Examples

### Exponential Decay Function
```typescript
// Source: Standard half-life formula (established mathematics)
// W(t) = 0.5^(t / t_half)
// W(0) = 1.0 (brand new), W(t_half) = 0.5 (half-life), W(2*t_half) = 0.25

export function exponentialDecay(ageDays: number, halfLifeDays: number): number {
  if (ageDays <= 0) return 1.0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}
```

### Config Extension
```typescript
// Source: existing src/config.ts pattern
export const config = {
  // ... existing fields ...
  recencyHalfLifeDays: Number(process.env.RECENCY_HALF_LIFE_DAYS ?? "14"),
} as const;
```

### Updated SearchOptions Interface
```typescript
// Source: existing src/repositories/types.ts
export interface SearchOptions {
  embedding: number[];
  project_id: string;
  scope: "project" | "user" | "both";  // D-08: add 'both'
  user_id?: string;
  limit?: number;
  min_similarity?: number;
}
```

### Type Strategy for Similarity vs Relevance
```typescript
// Repository returns raw similarity (internal use only)
// Keep MemoryWithScore as-is in repository layer for raw cosine similarity

// Service layer maps to new type with relevance (public interface)
export interface MemoryWithRelevance extends Memory {
  relevance: number;  // D-05, D-06: composite score replacing similarity
}

// Alternative: rename MemoryWithScore.similarity to relevance everywhere
// and have the repository temporarily use a different internal representation.
// The cleaner approach: rename MemoryWithScore to MemoryWithRelevance and rename the field.
// The repository search method returns data that gets transformed in the service layer.
```

**Recommended approach:** Rename `MemoryWithScore` to `MemoryWithRelevance` and change `similarity: number` to `relevance: number`. In the repository, have the search method still return rows with a `similarity` field internally, but the service layer transforms this to `relevance` after computing the composite score. This keeps the type system honest: the repository deals in raw similarity, the service deals in composite relevance.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.x |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCOP-03 | Cross-scope search returns memories from both project and user scopes | integration | `npx vitest run tests/integration/cross-scope-search.test.ts -x` | No -- Wave 0 |
| RETR-01 | Search returns results ranked by composite relevance | integration | `npx vitest run tests/integration/memory-search.test.ts -x` | Yes -- needs update for relevance field |
| RETR-02 | Composite scoring combines similarity + recency + verification | unit | `npx vitest run tests/unit/scoring.test.ts -x` | No -- Wave 0 |
| RETR-03 | Results include relevance score, creation date, author, tags | integration | `npx vitest run tests/integration/memory-search.test.ts -x` | Yes -- needs update for relevance field |
| RETR-04 | `memory_session_start` returns relevant memories | integration | `npx vitest run tests/integration/session-start.test.ts -x` | No -- Wave 0 |
| RETR-05 | Session start respects configurable limit | integration | `npx vitest run tests/integration/session-start.test.ts -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/unit/scoring.test.ts` -- unit tests for `computeRelevance()` and `exponentialDecay()` functions
- [ ] `tests/integration/cross-scope-search.test.ts` -- cross-scope search with `scope: 'both'`
- [ ] `tests/integration/session-start.test.ts` -- `memory_session_start` tool with and without context
- [ ] Update `tests/integration/memory-search.test.ts` -- change `.similarity` assertions to `.relevance`

## Open Questions

1. **Internal type for repository raw similarity**
   - What we know: The repository returns raw cosine similarity. The service layer computes composite relevance. D-05 says the public API returns `relevance` only.
   - What's unclear: Whether to keep `MemoryWithScore` with `similarity` field as an internal type (only used between repository and service), or to refactor the repository to return a different shape.
   - Recommendation: Keep `MemoryWithScore` with `similarity` as an internal/repository-layer type. Create `MemoryWithRelevance` with `relevance` as the public type. The service layer converts between them. This avoids breaking the repository contract while satisfying D-05 at the API boundary.

2. **No-context session start: recency-only query pattern**
   - What we know: When `memory_session_start` is called without `context`, there is no semantic query. We need to return recent memories from both scopes.
   - What's unclear: Whether to add a new repository method for recency-only queries, or reuse the existing `list` method adapted for cross-scope.
   - Recommendation: Add a dedicated method or reuse `list` with cross-scope support. Apply composite scoring with `similarity = 1.0` (neutral baseline) so the score is purely recency + verification. This keeps the scoring function consistent across both paths.

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/repositories/memory-repository.ts` -- current search implementation with cosine distance, `or()` import, app-layer filtering pattern
- Existing codebase: `src/services/memory-service.ts` -- service layer pattern, envelope response, embedding error handling
- Existing codebase: `src/tools/memory-search.ts` -- tool registration pattern with Zod schemas
- Existing codebase: `src/types/memory.ts` -- `MemoryWithScore` type to modify
- [Drizzle ORM Operators docs](https://orm.drizzle.team/docs/operators) -- `or()`, `and()`, dynamic WHERE construction
- [Drizzle ORM Conditional Filters](https://orm.drizzle.team/docs/guides/conditional-filters-in-query) -- dynamic query patterns
- Standard exponential decay formula: `W(t) = 0.5^(t/t_half)` -- established mathematics, universally documented

### Secondary (MEDIUM confidence)
- [Langflow: Beyond Basic RAG - Retrieval Weighting](https://www.langflow.org/blog/beyond-basic-rag-retrieval-weighting) -- conceptual validation of multiplicative similarity x decay pattern
- [Elastic Function Scoring](https://www.elastic.co/blog/found-function-scoring) -- decay function types (exponential, linear, gaussian) and combining with text relevance
- [Half-Life Decaying Model for Recommender Systems](https://ceur-ws.org/Vol-2038/paper1.pdf) -- academic validation of half-life approach in information retrieval

### Tertiary (LOW confidence)
- None. All findings verified against established mathematics or the existing codebase.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing libraries
- Architecture: HIGH -- patterns directly extend existing codebase patterns observed in Phase 1 source code
- Scoring formula: HIGH -- standard exponential decay mathematics; weights per user decision with Claude's discretion for fine-tuning
- Pitfalls: HIGH -- identified from reading actual code and understanding the type system

**Research date:** 2026-03-23
**Valid until:** 2026-04-23 (stable -- no external dependencies, purely internal logic)
