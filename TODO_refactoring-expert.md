# Refactoring Expert Analysis: agent-brain

## Context

**Codebase:** ~4,500 lines TypeScript across 41 source files
**Architecture:** Layered MCP server (tools -> service -> repository -> DB)
**Test Coverage:** Comprehensive (16 test files, ~3,900 lines)
**Overall Quality:** Good. Clean layering, well-typed, consistent patterns. No critical smells.

### Metrics Baseline

| File                 | Lines | Complexity | Notes                                             |
| -------------------- | ----- | ---------- | ------------------------------------------------- |
| memory-service.ts    | 720   | Medium     | `create()` ~175 lines, `sessionStart()` ~90 lines |
| memory-repository.ts | 608   | Medium     | Scope filtering repeated in 5 methods             |
| api-tools.ts         | 200   | Low        | Switch dispatcher, 11 cases                       |
| server.ts            | 208   | Low        | Clean startup, no smells                          |

### Code Smells Detected

| ID   | Smell                                                | Severity | Location                                                   |
| ---- | ---------------------------------------------------- | -------- | ---------------------------------------------------------- |
| CS-1 | Duplicated scope filtering logic                     | **High** | memory-repository.ts (5 methods)                           |
| CS-2 | Duplicated embedding error handling                  | Medium   | memory-service.ts (3 methods)                              |
| CS-3 | Duplicated `parseCursor` function                    | Medium   | tools/memory-list.ts:8 + routes/api-tools.ts:8             |
| CS-4 | Duplicated enum definitions                          | Low      | api-schemas.ts:4 + memory-create.ts:30 + memory-list.ts:46 |
| CS-5 | Optional constructor deps with scattered null checks | Low      | memory-service.ts constructor                              |

---

## Refactoring Plan

### RF-PLAN-1.1 Extract Scope Condition Builder [High Impact]

- [ ] **RF-PLAN-1.1 Extract scope condition builder**
  - **Target**: `memory-repository.ts` -- `search()`, `list()`, `findDuplicates()`, `listRecentBothScopes()`, `findRecentActivity()`
  - **Reason**: The pattern of building `SQL[]` conditions for scope-based access appears in 5 methods with subtle variations. Each builds workspace/user/project/both conditions independently, creating divergence risk.
  - **Risk**: Medium -- scope filtering is security-sensitive. Must verify all 5 call sites produce identical queries before/after.
  - **Priority**: 1

  **Before**: Each method manually builds scope conditions:

  ```typescript
  // In search():
  if (options.scope === "workspace") {
    conditions.push(or(eq(memories.project_id, ...), eq(memories.scope, "project"))!);
  } else if (options.scope === "user") { ... } else { ... }

  // In list(): different pattern
  if (options.scope === "workspace") {
    conditions.push(eq(memories.project_id, options.project_id));
  } else if (options.scope === "project") { ... } else { ... }

  // In listRecentBothScopes(): yet another inline pattern
  // In findRecentActivity(): another inline pattern
  // In findDuplicates(): another inline pattern
  ```

  **After**: Single `buildScopeConditions()` private method:

  ```typescript
  private buildScopeConditions(opts: {
    scope: "workspace" | "user" | "project" | "both";
    projectId?: string | null;
    userId?: string;
    includeProjectScope?: boolean; // whether to OR-in scope="project"
  }): SQL[] { ... }
  ```

  **Metrics**: ~80 lines of duplicated logic -> ~25 lines shared + 5 call sites. Reduces divergence risk for scope filtering (security-critical).

  **Caveat**: `list()` uses different scope semantics (no "both", has "project" as standalone scope, no project-scope OR). `findDuplicates()` has unique cross-scope dedup logic. The builder must handle these variants or some methods may not benefit. Don't force-fit -- if a method's scope logic is genuinely distinct, leave it inline.

### RF-PLAN-2.1 Extract Embedding Helper [Medium Impact]

- [ ] **RF-PLAN-2.1 Extract embedding helper in MemoryService**
  - **Target**: `memory-service.ts` -- `create()`:137-145, `update()`:444-451, `search()`:507-514
  - **Reason**: Identical try/catch pattern wrapping `this.embeddingProvider.embed()` with `EmbeddingError` re-throw appears 3 times.
  - **Risk**: Low -- pure extraction, no behavior change.
  - **Priority**: 2

  **Before** (repeated 3x):

  ```typescript
  let embedding: number[];
  try {
    embedding = await this.embeddingProvider.embed(input);
  } catch (error) {
    if (error instanceof EmbeddingError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new EmbeddingError(`Failed to generate embedding: ${message}`);
  }
  ```

  **After**:

  ```typescript
  private async embed(input: string): Promise<number[]> {
    try {
      return await this.embeddingProvider.embed(input);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingError(`Failed to generate embedding: ${message}`);
    }
  }
  ```

  **Metrics**: 3x 7-line blocks -> 1x 8-line method + 3x 1-line calls. Net: -12 lines, eliminates duplication.

### RF-PLAN-3.1 Consolidate parseCursor [Medium Impact]

- [ ] **RF-PLAN-3.1 Consolidate `parseCursor` into shared utility**
  - **Target**: `tools/memory-list.ts:8-18` and `routes/api-tools.ts:8-22`
  - **Reason**: Two implementations of the same cursor parsing logic. The route version throws `ValidationError` on bad format; the tool version silently returns undefined. Should pick one behavior and share.
  - **Risk**: Low -- straightforward extraction.
  - **Priority**: 3

  **After**: Move to `utils/cursor.ts`, throw on invalid format (routes behavior), import from both locations.

### RF-PLAN-4.1 Share Enum Definitions [Low Impact]

- [ ] **RF-PLAN-4.1 Share `memoryTypeEnum` and `scopeEnum` across MCP tools and API schemas**
  - **Target**: `routes/api-schemas.ts:4-13` defines `memoryTypeEnum` and `scopeEnum`. Each MCP tool file (`memory-create.ts`, `memory-list.ts`, etc.) defines them inline.
  - **Reason**: 4+ copies of the same enum. Adding a new memory type requires updating every file.
  - **Risk**: Low -- pure extraction.
  - **Priority**: 4

  **After**: Export from `utils/validation.ts` (which already exports `slugSchema` and `contentSchema`). Import everywhere.

### RF-PLAN-5.1 [Deferred] Optional Constructor Dependencies

- [ ] **RF-PLAN-5.1 [DEFERRED] Consider required deps for MemoryService**
  - **Target**: `memory-service.ts:40-42` -- `commentRepo?`, `sessionRepo?`, `sessionLifecycleRepo?`
  - **Reason**: Optional deps lead to `if (this.commentRepo)` / `if (this.sessionRepo)` checks in 5+ locations. All callers (server.ts:75-82) always pass all deps.
  - **Risk**: Medium -- would break test setup if tests construct MemoryService without all deps.
  - **Priority**: 5 (defer unless test refactoring is already planned)

  **Note**: This is pragmatic tech debt. The optional deps exist so tests can construct a minimal service. Making them required would need a test helper or mock factory. Not worth doing in isolation.

---

## Quality Assurance Checklist

- [ ] All existing tests pass without modification to test assertions
- [ ] Each refactoring step is independently verifiable and reversible
- [ ] Before/after metrics demonstrate measurable improvement
- [ ] No behavior changes mixed with structural refactoring
- [ ] Scope filtering produces identical SQL before and after RF-PLAN-1.1
- [ ] Technical debt tracked with TODO comments where deferred
- [ ] Follow-up refactorings documented

## Execution Recommendation

**Start with RF-PLAN-2.1** (embedding helper) -- lowest risk, clearest win, builds confidence. Then RF-PLAN-3.1 (parseCursor) and RF-PLAN-4.1 (enums) as quick wins. Tackle RF-PLAN-1.1 (scope conditions) last -- highest value but needs careful verification that each method's scope semantics are preserved.

Total estimated reduction: ~60-80 lines of duplication eliminated, 4 fewer places to update when scope logic or enum values change.
