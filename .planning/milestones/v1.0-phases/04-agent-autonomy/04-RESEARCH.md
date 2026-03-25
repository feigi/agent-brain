# Phase 4: Agent Autonomy - Research

**Researched:** 2026-03-23
**Domain:** Autonomous agent memory capture, write budgets, semantic deduplication, MCP prompt resources, Claude Code hooks
**Confidence:** HIGH

## Summary

Phase 4 transforms the memory system from purely manual saves into one where agents autonomously capture insights during sessions. The implementation adds five capabilities: (1) an MCP prompt resource providing system-level guidance on what to remember, (2) server-generated session IDs from `memory_session_start`, (3) write budget tracking per session to prevent memory bloat, (4) semantic duplicate detection on `memory_create`, and (5) Claude Code hook templates for session-end review triggers. All five capabilities build on existing infrastructure -- the embedding pipeline, session tracking, envelope response format, and source field on memories are already in place.

The most significant architectural change is to `memory_create`, which gains two new pre-save checks (budget and dedup) that run before the existing embedding + insert flow. The session_start tool gains a return value (session_id). A new `sessions` table replaces the current `session_tracking` table to hold per-session budget counters. An MCP prompt resource is registered alongside the existing tools. Everything else is configuration (env vars) and documentation (hook templates).

**Primary recommendation:** Implement in order: (1) session ID generation, (2) write budget tracking, (3) duplicate detection, (4) MCP prompt resource, (5) hook templates. The first three are tightly coupled (session_id enables budget, budget gates create), while the last two are independent deliverables.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** MCP prompt resource (`memory-guidance` or similar) for system prompt guidance on what patterns are worth remembering. Prompt content lives in the server codebase and is versioned with it.
- **D-02:** No auto-injection -- users configure their agent (e.g., CLAUDE.md, agent settings) to invoke the prompt at session start. Documentation provides setup instructions.
- **D-03:** All memory types (`fact`, `decision`, `learning`, `pattern`, `preference`, `architecture`) are equal priority. The agent judges what's worth capturing based on context.
- **D-04:** Session-end review is agent behavior, not a server-side tool. No new `memory_session_end` tool. Agent uses existing `memory_create` with `source: 'session-review'`.
- **D-05:** Continuous capture pattern -- agent saves at natural breakpoints throughout the session (after completing tasks, commits, milestones) AND does a final review when the user signals they're wrapping up.
- **D-06:** Abrupt exits lose only learnings since the last breakpoint capture. Acceptable trade-off for simplicity.
- **D-07:** Ship ready-to-use Claude Code hook configuration templates as part of Phase 4 deliverables: Stop hook (triggers session-end review) and PostToolCall hook on `memory_create` (optional, tracks autonomous saves).
- **D-08:** Hooks are configuration files/documentation only -- no server code.
- **D-09:** Hooks are a recommended enhancement for Claude Code users, not a requirement. Other MCP clients rely on the natural-breakpoints pattern from the prompt.
- **D-10:** Server-side tracking per session_id. Server counts autonomous writes (`source: 'agent-auto'` or `source: 'session-review'`) against the budget. Manual writes (`source: 'manual'`) do not count.
- **D-11:** Configurable via env var `WRITE_BUDGET_PER_SESSION` (default: 10).
- **D-12:** Soft response, not error. `memory_create` response includes budget metadata: `{ budget: { used: N, limit: M, exceeded: boolean } }`.
- **D-13:** On budget exceeded: soft reject -- memory is NOT created. Response returns `{ budget: { used: 10, limit: 10, exceeded: true }, skipped: true }` with a message. Not an MCP error -- agent can still force-save by using `source: 'manual'`.
- **D-14:** Semantic duplicate detection on ALL `memory_create` calls (manual and autonomous). Prevents duplicates regardless of source.
- **D-15:** Configurable cosine similarity threshold via env var `DUPLICATE_THRESHOLD` (default: 0.90).
- **D-16:** Scope-aware checking: project memories checked against project only; user memories checked against user memories AND project memories. If match in project scope, response says "this already exists as shared knowledge."
- **D-17:** On duplicate detected: soft reject -- memory NOT saved. Response includes existing duplicate: `{ duplicate: true, existing: { id, title, relevance } }`. Agent can update the existing memory instead.
- **D-18:** Server generates session_id on `memory_session_start` call. Returned in the response. Server is the source of truth for session IDs.
- **D-19:** `memory_create` requires session_id for autonomous writes (`source: 'agent-auto'` or `source: 'session-review'`). Server rejects autonomous writes without a session_id.
- **D-20:** `memory_create` with `source: 'manual'` does not require session_id. Optional -- if provided, the save is associated with the session but does not count toward budget.
- **D-21:** Sessions do not expire. No TTL on session_id. Budget is lifetime per session_id.

### Claude's Discretion

- MCP prompt resource name and content structure
- Exact hook template content and configuration format
- How budget metadata is structured in the response envelope (fits within existing `meta` pattern)
- How duplicate check integrates with the embedding flow (check before or after generating embedding for the new memory)
- Session ID format (nanoid recommended, consistent with existing ID generation)
- Error message wording for missing session_id on autonomous writes
  </user_constraints>

<phase_requirements>

## Phase Requirements

| ID      | Description                                                                        | Research Support                                                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AUTO-01 | Agent can autonomously save insights mid-session without explicit user instruction | MCP prompt resource provides guidance on what to capture; existing `memory_create` with `source: 'agent-auto'` is the mechanism; session_id links saves to a session           |
| AUTO-02 | System prompt guidance defines what patterns are worth remembering                 | MCP prompt resource (`registerPrompt`) delivers versioned guidance content; SDK supports prompt registration with args schema                                                  |
| AUTO-03 | Agent can perform session-end review and extract key learnings                     | Continuous capture pattern via prompt guidance; Claude Code Stop hook template triggers review; `source: 'session-review'` distinguishes end-of-session saves                  |
| AUTO-04 | Write budget limits the number of autonomous saves per session                     | New sessions table with budget counter; server-side tracking per session_id; soft reject on exceeded; configurable via `WRITE_BUDGET_PER_SESSION` env var                      |
| AUTO-05 | Duplicate detection prevents saving memories semantically similar to existing ones | Cosine similarity check against existing memories before insert; scope-aware (project vs user+project); configurable threshold via `DUPLICATE_THRESHOLD` env var; 0.90 default |

</phase_requirements>

## Standard Stack

No new libraries are needed for Phase 4. All functionality builds on the existing stack.

### Core (already installed)

| Library                   | Version | Purpose       | Phase 4 Usage                                                 |
| ------------------------- | ------- | ------------- | ------------------------------------------------------------- |
| @modelcontextprotocol/sdk | ^1.27.1 | MCP server    | `server.registerPrompt()` for memory guidance prompt resource |
| drizzle-orm               | ^0.45.1 | ORM           | New sessions table, budget counter queries                    |
| pgvector (extension)      | 0.8.x   | Vector search | Cosine distance for duplicate detection                       |
| nanoid                    | ^5.1.7  | ID generation | Session ID generation via existing `generateId()`             |
| zod                       | ^4.3.6  | Validation    | Prompt argsSchema, new config validation                      |
| vitest                    | ^4.1.0  | Testing       | Unit + integration tests for budget, dedup, session lifecycle |

### No New Dependencies

Phase 4 requires zero additional npm packages. The duplicate detection reuses the existing embedding pipeline and `cosineDistance` from Drizzle. Budget tracking is a simple counter in Postgres. The MCP prompt resource uses the SDK's built-in `registerPrompt()`.

## Architecture Patterns

### New/Modified Files

```
src/
  config.ts                        # [MODIFY] Add WRITE_BUDGET_PER_SESSION, DUPLICATE_THRESHOLD
  server.ts                        # [MODIFY] Register prompt resource
  db/
    schema.ts                      # [MODIFY] Add sessions table (replaces session_tracking for session_id lifecycle)
  types/
    memory.ts                      # [MODIFY] Add CreateResponse type with budget/dedup metadata
    envelope.ts                    # [MODIFY] Add budget metadata to Envelope meta
  repositories/
    types.ts                       # [MODIFY] Add SessionRepository interface (replaces SessionTrackingRepository)
    session-repository.ts          # [MODIFY] Rewrite for session_id lifecycle + budget counters
    memory-repository.ts           # [MODIFY] Add findDuplicates() method
  services/
    memory-service.ts              # [MODIFY] Add budget check, dedup check, session_id validation to create()
  tools/
    memory-create.ts               # [MODIFY] Pass session_id, validate autonomous source requires session_id
    memory-session-start.ts        # [MODIFY] Generate and return session_id
  prompts/
    memory-guidance.ts             # [NEW] MCP prompt resource registration
  hooks/                           # [NEW] Documentation-only: Claude Code hook templates
    README.md                      # Setup instructions
    stop-hook.sh                   # Stop hook script for session-end review
    settings-snippet.json          # Hook configuration for .claude/settings.json
tests/
  unit/
    budget.test.ts                 # [NEW] Budget logic unit tests
    dedup.test.ts                  # [NEW] Dedup threshold logic unit tests
  integration/
    session-lifecycle.test.ts      # [NEW] Session ID generation, budget tracking, session-scoped creates
    duplicate-detection.test.ts    # [NEW] Dedup against existing memories, scope-aware checking
```

### Pattern 1: Pre-Save Guard Chain in memory_create

**What:** `memory_create` gains a chain of pre-save checks: (1) validate session_id for autonomous writes, (2) check write budget, (3) check duplicate. Each guard can short-circuit with a soft response.

**When to use:** Any `memory_create` call. Guards run in this specific order because session validation must happen before budget check (budget is per-session), and budget check must happen before dedup (no point checking duplicates if over budget).

**Example:**

```typescript
// In MemoryService.create():
async create(input: MemoryCreate): Promise<Envelope<Memory | CreateSkipResult>> {
  const isAutonomous = input.source === 'agent-auto' || input.source === 'session-review';

  // Guard 1: Validate session_id for autonomous writes (D-19)
  if (isAutonomous && !input.session_id) {
    throw new ValidationError("session_id is required for autonomous writes (source: 'agent-auto' or 'session-review')");
  }

  // Guard 2: Check write budget (D-10, D-12, D-13)
  if (isAutonomous && input.session_id) {
    const budget = await this.sessionRepo.getBudget(input.session_id);
    if (budget.used >= budget.limit) {
      return {
        data: { skipped: true, reason: 'budget_exceeded' },
        meta: { budget: { used: budget.used, limit: budget.limit, exceeded: true }, timing: Date.now() - start },
      };
    }
  }

  // Guard 3: Duplicate detection (D-14, D-15, D-16, D-17)
  // Generate embedding first (needed for both dedup check and storage)
  const embedding = await this.embeddingProvider.embed(embeddingInput);
  const duplicate = await this.findDuplicate(embedding, input);
  if (duplicate) {
    return {
      data: { skipped: true, reason: 'duplicate', duplicate: { id: duplicate.id, title: duplicate.title, relevance: duplicate.relevance } },
      meta: { timing: Date.now() - start },
    };
  }

  // Proceed with normal create flow...
  // After successful insert, increment budget counter
  if (isAutonomous && input.session_id) {
    await this.sessionRepo.incrementBudgetUsed(input.session_id);
  }
}
```

### Pattern 2: Session ID Lifecycle

**What:** `memory_session_start` generates a unique session_id (nanoid), stores it in a `sessions` table with budget counters, and returns it alongside the existing session_start response. The session_id is the primary key for budget tracking.

**When to use:** Every `memory_session_start` call creates a new session record.

**Example:**

```typescript
// In MemoryService.sessionStart() -- additions to existing method:
async sessionStart(projectId, userId, context?, limit?) {
  // ... existing logic (auto-create project, session tracking, search) ...

  // NEW: Generate session_id (D-18)
  const sessionId = generateId(); // nanoid(21)
  await this.sessionRepo.createSession(sessionId, userId, projectId);

  return {
    data: result.data,
    meta: {
      ...result.meta,
      session_id: sessionId,  // NEW: returned to agent
      team_activity: teamActivity,
    },
  };
}
```

### Pattern 3: Scope-Aware Duplicate Detection

**What:** Before inserting a new memory, compute cosine similarity against existing memories in the appropriate scope. Project memories check against project scope only. User memories check against both user and project scope (D-16).

**When to use:** Every `memory_create` call, regardless of source.

**Example:**

```typescript
// In MemoryRepository -- new method:
async findDuplicates(
  embedding: number[],
  projectId: string,
  scope: 'project' | 'user',
  userId: string,
  threshold: number, // e.g., 0.90
  limit: number = 1,
): Promise<MemoryWithRelevance[]> {
  const distance = cosineDistance(memories.embedding, embedding);
  const similarity = sql<number>`1 - (${distance})`;

  const conditions: SQL[] = [isNull(memories.archived_at)];

  if (scope === 'project') {
    // D-16: Project memories check against project scope only
    conditions.push(eq(memories.project_id, projectId));
  } else {
    // D-16: User memories check against BOTH user and project scope
    conditions.push(
      or(
        eq(memories.project_id, projectId),
        and(eq(memories.author, userId), eq(memories.scope, 'user')),
      )!,
    );
  }

  const result = await this.db
    .select({ ...this.memoryColumns(), similarity })
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(similarity))
    .limit(limit);

  return result
    .filter(row => Number(row.similarity) >= threshold)
    .map(row => ({
      ...rowToMemory(row),
      relevance: Number(row.similarity),
    }));
}
```

### Pattern 4: MCP Prompt Resource

**What:** Register a prompt resource that agents can invoke to get guidance on what to remember. The prompt contains zero arguments (it returns static guidance text) or optionally accepts a project context string.

**When to use:** Agents invoke `memory-guidance` at session start (configured via CLAUDE.md or agent settings).

**Example:**

```typescript
// src/prompts/memory-guidance.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMemoryGuidance(server: McpServer): void {
  server.registerPrompt(
    "memory-guidance",
    {
      description:
        "Guidelines for autonomous memory capture -- what to remember and when",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: MEMORY_GUIDANCE_TEXT,
          },
        },
      ],
    }),
  );
}

const MEMORY_GUIDANCE_TEXT = `
## Memory Capture Guidelines

You have access to a long-term memory system. Save insights that will be valuable in future sessions.

### What to Capture
- **Decisions**: Architecture choices, technology selections, trade-off resolutions
- **Conventions**: Naming patterns, file organization rules, coding standards agreed upon
- **Gotchas**: Non-obvious bugs, workarounds, platform quirks discovered during work
- **Architecture**: System boundaries, data flow patterns, integration points
- **Patterns**: Reusable solutions that worked, anti-patterns to avoid
- **Preferences**: User preferences for tools, approaches, communication style

### When to Save (Natural Breakpoints)
- After completing a task or subtask
- After a commit that involved a non-obvious decision
- When discovering something surprising about the codebase
- After resolving a tricky bug (save the root cause + fix)
- When the user shares team context or decisions

### When NOT to Save
- Trivial facts easily found in code (import paths, obvious function signatures)
- Temporary debugging observations
- Information already captured in an existing memory
- Task-specific details that won't generalize

### Session-End Review
When the session is ending, review your work and extract any remaining learnings not yet captured.
Use source: 'session-review' for end-of-session saves.

### Budget Awareness
You have a limited write budget per session. Prioritize the most impactful insights.
If budget is exceeded, the server will softly reject saves -- you can still save manually if critical.
`.trim();
```

### Pattern 5: Claude Code Stop Hook for Session-End Review

**What:** A Claude Code hook that fires when Claude stops responding. The hook script outputs a JSON decision that blocks the stop and asks Claude to perform a session-end review before exiting.

**When to use:** Claude Code users who want automated session-end reviews.

**Example (hook configuration):**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-session-review.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/memory-session-review.sh
INPUT=$(cat)
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active')

# Prevent infinite loop -- if already in a stop hook, let it through
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

# Block the stop and ask Claude to do a session-end review
cat <<'REVIEW'
{
  "decision": "block",
  "reason": "Before ending, please perform a session-end memory review: reflect on this session's work and save any key learnings, decisions, or patterns worth remembering using memory_create with source 'session-review'. Then you may stop."
}
REVIEW
exit 0
```

### Anti-Patterns to Avoid

- **Checking duplicates without generating the embedding first:** The dedup check requires the embedding of the new memory. Generate it once and reuse for both dedup check and storage.
- **Counting budget in the application layer instead of the database:** A race condition exists if two concurrent autonomous writes happen in the same session. Use an atomic database counter (UPDATE ... SET used = used + 1 WHERE used < limit RETURNING used).
- **Throwing MCP errors for budget/dedup rejections:** D-12/D-13/D-17 explicitly require soft responses, not error responses. Return normal tool results with skip indicators.
- **Blocking manual writes with budget checks:** D-10 and D-20 explicitly exclude `source: 'manual'` from budget counting. Only `agent-auto` and `session-review` count.

## Don't Hand-Roll

| Problem                       | Don't Build                   | Use Instead                                                                                                  | Why                                                                                                                                         |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cosine similarity computation | Application-layer vector math | pgvector `cosineDistance()` via Drizzle                                                                      | pgvector uses SIMD-optimized C code and leverages HNSW index. Application-layer math would require loading all vectors into Node.js memory. |
| Session ID generation         | UUID or timestamp-based IDs   | `nanoid(21)` via existing `generateId()`                                                                     | Consistent with all other IDs in the system. 148 bits of entropy. URL-safe.                                                                 |
| Atomic budget counter         | SELECT + check + UPDATE       | `UPDATE sessions SET budget_used = budget_used + 1 WHERE id = $1 AND budget_used < $2 RETURNING budget_used` | Single atomic SQL statement prevents race conditions from concurrent writes.                                                                |
| Hook scripting framework      | Custom hook runner            | Claude Code's built-in hook system                                                                           | Hooks are Claude Code's native feature. Ship configuration, not infrastructure.                                                             |
| Prompt template system        | Dynamic prompt generator      | MCP SDK `registerPrompt()`                                                                                   | The SDK has first-class support for prompt resources. Clients discover and invoke them via the MCP protocol.                                |

**Key insight:** Every capability in Phase 4 is implemented by extending existing patterns (envelope responses, guard chains, repository methods, config env vars) rather than introducing new abstractions.

## Common Pitfalls

### Pitfall 1: Duplicate Detection Embedding Order

**What goes wrong:** Generating the embedding for the new memory AFTER the dedup check, which means you'd need to generate it twice (once for dedup, once for storage) or restructure the flow.
**Why it happens:** Natural instinct is to check first, then compute. But dedup requires comparing embeddings.
**How to avoid:** Generate the embedding early in the create flow. Pass it to both the dedup check and the insert. The existing code already generates embedding before insert -- simply move the dedup check between embedding generation and insert.
**Warning signs:** Embedding provider called twice for the same content.

### Pitfall 2: Stop Hook Infinite Loop

**What goes wrong:** Claude Code Stop hook blocks the stop, Claude does the review, tries to stop again, hook blocks again, infinite loop.
**Why it happens:** The hook fires every time Claude attempts to stop. Without checking `stop_hook_active`, it blocks every attempt.
**How to avoid:** Always check `stop_hook_active` in the Stop hook script. When true, immediately exit 0 to allow the stop.
**Warning signs:** Claude keeps reviewing and never actually stops.

### Pitfall 3: Budget Counter Race Condition

**What goes wrong:** Two concurrent autonomous writes both read budget_used=9, both proceed, both write, budget_used becomes 11 (exceeds limit of 10).
**Why it happens:** SELECT then UPDATE is not atomic.
**How to avoid:** Use a single atomic UPDATE statement: `UPDATE sessions SET budget_used = budget_used + 1 WHERE id = $1 AND budget_used < $limit RETURNING budget_used`. If RETURNING returns 0 rows, budget is exceeded.
**Warning signs:** budget_used exceeds the configured limit.

### Pitfall 4: Dedup Scope Logic Reversed

**What goes wrong:** Checking project memories against both scopes (wrong) instead of user memories against both scopes (correct per D-16).
**Why it happens:** The asymmetric scope logic is counterintuitive.
**How to avoid:** Explicit branching: `if (scope === 'project') { check project only } else { check user + project }`. Add integration tests for both branches.
**Warning signs:** Project memories being flagged as duplicates of user memories.

### Pitfall 5: Session Tracking Table Conflict

**What goes wrong:** The existing `session_tracking` table (user_id, project_id, last_session_at) conflicts with the new `sessions` table needed for session_id lifecycle.
**Why it happens:** Phase 3 created `session_tracking` for team activity (last-session-at per user/project). Phase 4 needs per-session-id records.
**How to avoid:** Keep `session_tracking` for its original purpose (team activity detection). Add a NEW `sessions` table for Phase 4 session lifecycle (id, user_id, project_id, budget_used, created_at). Both tables serve different purposes. `session_start` tool updates both.
**Warning signs:** Trying to add session_id to session_tracking breaks the unique constraint on (user_id, project_id).

### Pitfall 6: Mock Embedding Provider Dedup Sensitivity

**What goes wrong:** The mock embedding provider uses a hash-based deterministic approach. Slightly different text may produce very different vectors (hash avalanche), making dedup tests unreliable for "similar but not identical" content.
**Why it happens:** The mock provider is designed for deterministic testing, not semantic similarity.
**How to avoid:** Test dedup with: (1) identical content (must detect, similarity = 1.0), (2) completely different content (must not detect), and (3) for near-duplicate testing, use the same text with minor variations and verify the threshold logic works even if mock similarity values don't perfectly model real semantics. Consider adding a test helper that creates memories with known embedding vectors directly.
**Warning signs:** Dedup integration tests pass only with identical text but fail with semantically similar text.

### Pitfall 7: Soft Reject Response Type Mismatch

**What goes wrong:** The `create()` method currently returns `Envelope<Memory>`. With soft rejects for budget/dedup, it needs to return either a Memory or a skip result. TypeScript union types or a discriminated union are needed.
**Why it happens:** The existing return type doesn't account for "operation succeeded but memory was not created."
**How to avoid:** Use a discriminated union response type. The tool layer already serializes to JSON text, so the TypeScript type change is internal. The MCP tool response is always `{ content: [{ type: "text", text: JSON.stringify(envelope) }] }` regardless of the data shape.
**Warning signs:** TypeScript compilation errors when the create method returns different shapes.

## Code Examples

### Session Table Schema (Drizzle)

```typescript
// src/db/schema.ts -- NEW table
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // nanoid session_id
  user_id: text("user_id").notNull(),
  project_id: text("project_id")
    .notNull()
    .references(() => projects.id),
  budget_used: integer("budget_used").notNull().default(0),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

### Config Extensions

```typescript
// src/config.ts -- additions
export const config = {
  // ... existing config ...
  writeBudgetPerSession: Number(process.env.WRITE_BUDGET_PER_SESSION ?? "10"),
  duplicateThreshold: Number(process.env.DUPLICATE_THRESHOLD ?? "0.90"),
} as const;
```

### Atomic Budget Increment (Repository)

```typescript
// In SessionRepository:
async incrementBudgetUsed(sessionId: string, limit: number): Promise<{ used: number; exceeded: boolean }> {
  const result = await this.db
    .update(sessions)
    .set({ budget_used: sql`${sessions.budget_used} + 1` })
    .where(
      and(
        eq(sessions.id, sessionId),
        sql`${sessions.budget_used} < ${limit}`,
      ),
    )
    .returning({ budget_used: sessions.budget_used });

  if (result.length === 0) {
    // Budget already at limit -- return current count
    const current = await this.db
      .select({ budget_used: sessions.budget_used })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return { used: current[0]?.budget_used ?? limit, exceeded: true };
  }

  return { used: result[0].budget_used, exceeded: false };
}
```

### Duplicate Detection (Repository)

```typescript
// In MemoryRepository -- new method
async findDuplicates(options: {
  embedding: number[];
  projectId: string;
  scope: 'project' | 'user';
  userId: string;
  threshold: number;
}): Promise<Array<{ id: string; title: string; relevance: number }>> {
  const distance = cosineDistance(memories.embedding, options.embedding);
  const similarity = sql<number>`1 - (${distance})`;

  const conditions: SQL[] = [isNull(memories.archived_at)];

  if (options.scope === 'project') {
    conditions.push(eq(memories.project_id, options.projectId));
  } else {
    // User memories checked against both user AND project scope (D-16)
    conditions.push(
      or(
        eq(memories.project_id, options.projectId),
        and(eq(memories.author, options.userId), eq(memories.scope, 'user')),
      )!,
    );
  }

  const result = await this.db
    .select({
      id: memories.id,
      title: memories.title,
      scope: memories.scope,
      similarity,
    })
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(similarity))
    .limit(1);

  return result
    .filter(row => Number(row.similarity) >= options.threshold)
    .map(row => ({
      id: row.id,
      title: row.title,
      scope: row.scope,
      relevance: Number(row.similarity),
    }));
}
```

### Envelope Meta Extension

```typescript
// src/types/envelope.ts -- add budget metadata
export interface Envelope<T> {
  data: T;
  meta: {
    count?: number;
    timing?: number;
    cursor?: string;
    has_more?: boolean;
    team_activity?: {
      /* existing */
    };
    comment_count?: number;
    session_id?: string; // NEW: returned from session_start
    budget?: {
      // NEW: returned from memory_create
      used: number;
      limit: number;
      exceeded: boolean;
    };
  };
}
```

## State of the Art

| Old Approach                 | Current Approach                     | When Changed | Impact                                                                               |
| ---------------------------- | ------------------------------------ | ------------ | ------------------------------------------------------------------------------------ |
| Client generates session IDs | Server generates session IDs         | Phase 4      | Server is source of truth for session lifecycle; enables server-side budget tracking |
| No write limits              | Budget per session (default 10)      | Phase 4      | Prevents memory bloat from chatty agents                                             |
| No dedup                     | Semantic dedup with cosine threshold | Phase 4      | Prevents near-identical memories from accumulating                                   |
| Tools-only MCP server        | Tools + Prompt resource              | Phase 4      | Agents can request guidance via standard MCP protocol                                |

## Open Questions

1. **Should the budget check happen before or after embedding generation?**
   - What we know: Embedding generation costs time (~200ms) and money ($0.02/1M tokens). Budget checks are cheap (one SQL query).
   - What's unclear: Whether the marginal savings justify the code complexity of checking budget first.
   - Recommendation: Check budget BEFORE embedding generation. If budget is exceeded, skip the embedding entirely. This saves latency and (trivially) cost. The guard chain order is: (1) session validation, (2) budget check, (3) embed, (4) dedup check, (5) insert.

2. **Should `session_tracking` and `sessions` be merged?**
   - What we know: `session_tracking` (user_id, project_id, last_session_at) serves team activity detection. `sessions` (id, user_id, project_id, budget_used) serves per-session lifecycle.
   - What's unclear: Whether the existing UPSERT behavior of session_tracking needs to change.
   - Recommendation: Keep both tables. `session_tracking` continues to UPSERT on every session_start (for team activity). `sessions` inserts a new row per session_start (for budget). Both are updated in the same `sessionStart()` call. This avoids any migration risk to the existing team activity feature.

3. **How should the prompt resource handle arguments?**
   - What we know: The MCP SDK supports prompt args via Zod schemas. The guidance is mostly static content.
   - What's unclear: Whether the prompt should accept a project context argument to customize guidance.
   - Recommendation: Start with zero arguments (static guidance). The guidance is universal across all projects. If customization is needed later, add an optional `context` argument. Simplicity first.

## Validation Architecture

### Test Framework

| Property           | Value                               |
| ------------------ | ----------------------------------- |
| Framework          | vitest 4.1.x                        |
| Config file        | `vitest.config.ts`                  |
| Quick run command  | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run`                    |

### Phase Requirements to Test Map

| Req ID  | Behavior                                                   | Test Type          | Automated Command                                                                                                    | File Exists? |
| ------- | ---------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------ |
| AUTO-01 | Agent saves with source 'agent-auto' requiring session_id  | integration        | `npx vitest run tests/integration/session-lifecycle.test.ts -t "autonomous"`                                         | Wave 0       |
| AUTO-02 | Prompt resource registered and returns guidance content    | integration        | `npx vitest run tests/integration/prompt-resource.test.ts`                                                           | Wave 0       |
| AUTO-03 | Agent saves with source 'session-review'                   | integration        | `npx vitest run tests/integration/session-lifecycle.test.ts -t "session-review"`                                     | Wave 0       |
| AUTO-04 | Budget tracking: increment, limit enforcement, soft reject | unit + integration | `npx vitest run tests/unit/budget.test.ts && npx vitest run tests/integration/session-lifecycle.test.ts -t "budget"` | Wave 0       |
| AUTO-05 | Duplicate detection: threshold, scope-aware, soft reject   | unit + integration | `npx vitest run tests/unit/dedup.test.ts && npx vitest run tests/integration/duplicate-detection.test.ts`            | Wave 0       |

### Sampling Rate

- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/unit/budget.test.ts` -- covers AUTO-04 budget logic (threshold, counting, exceeded detection)
- [ ] `tests/unit/dedup.test.ts` -- covers AUTO-05 threshold comparison and scope logic
- [ ] `tests/integration/session-lifecycle.test.ts` -- covers AUTO-01, AUTO-03, AUTO-04 (session_id creation, budget tracking, autonomous writes)
- [ ] `tests/integration/duplicate-detection.test.ts` -- covers AUTO-05 (dedup against existing memories, scope-aware checking, soft reject response)
- [ ] `tests/integration/prompt-resource.test.ts` -- covers AUTO-02 (prompt registration and content verification)
- [ ] Migration for `sessions` table -- `drizzle-kit generate` then `drizzle-kit migrate`

## Environment Availability

Step 2.6: No new external dependencies. Phase 4 uses only existing tooling (Docker Postgres, Node.js, tsx, vitest, drizzle-kit). All dependencies verified in prior phases.

## Sources

### Primary (HIGH confidence)

- **Existing codebase** -- `src/services/memory-service.ts`, `src/repositories/memory-repository.ts`, `src/tools/memory-create.ts`, `src/tools/memory-session-start.ts`, `src/db/schema.ts`, `src/config.ts` -- all reviewed for integration points
- **MCP TypeScript SDK server docs** -- `registerPrompt()` API confirmed via [GitHub docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- **Claude Code hooks documentation** -- [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) -- Stop hook configuration, `stop_hook_active` field, JSON decision format
- **pgvector cosineDistance** -- Already used in `memory-repository.ts` search method; same API for dedup

### Secondary (MEDIUM confidence)

- **Cosine similarity thresholds for dedup** -- [OpenAI community discussion](https://community.openai.com/t/rule-of-thumb-cosine-similarity-thresholds/693670) and [Zilliz FAQ](https://zilliz.com/ai-faq/how-do-i-use-embeddings-for-duplicate-detection) -- 0.90 threshold is well-established for near-duplicate detection
- **Claude Code hooks guide** -- [eesel.ai blog](https://www.eesel.ai/blog/hooks-in-claude-code) and [smartscope.blog](https://smartscope.blog/en/generative-ai/claude/claude-code-hooks-guide/) -- hook handler types and configuration patterns

### Tertiary (LOW confidence)

- None -- all findings verified against primary sources or multiple secondary sources.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH -- no new libraries, all existing stack reused
- Architecture: HIGH -- all integration points verified against existing source code; patterns follow established conventions
- Pitfalls: HIGH -- race conditions, infinite loops, and scope logic identified from code review and domain knowledge
- Hook templates: MEDIUM -- Claude Code hook API verified via official docs, but specific behavior with MCP tool calls needs runtime testing

**Research date:** 2026-03-23
**Valid until:** 2026-04-23 (stable -- no external dependencies changing)
