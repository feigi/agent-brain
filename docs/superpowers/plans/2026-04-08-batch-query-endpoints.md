# Batch Query Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce agent tool calls for read operations by supporting arrays in `memory_list` (scope), `memory_get` (ids + optional includes), `memory_relationships` (memory_ids), and `memory_search` (scope).

**Architecture:** In-place schema evolution of four MCP tools. Add `flag_count` and `relationship_count` correlated subqueries to `memoryColumns()`. New `getMany()` service method with optional batch joins for comments, flags, and relationships. Repository methods updated to accept arrays where they previously took single values.

**Tech Stack:** TypeScript, Zod, Drizzle ORM, PostgreSQL, MCP SDK

---

### Task 1: Add `flag_count` and `relationship_count` to `memoryColumns()`

**Files:**

- Modify: `src/types/memory.ts:18-41` (Memory interface)
- Modify: `src/types/memory.ts:44-59` (MemorySummary interface)
- Modify: `src/repositories/memory-repository.ts:57-64` (rowToMemory)
- Modify: `src/repositories/memory-repository.ts:71-79` (memoryColumns)
- Test: `tests/integration/memory-crud.test.ts`

- [ ] **Step 1: Write failing test for flag_count and relationship_count**

In `tests/integration/memory-crud.test.ts`, add a test after the existing tests:

```typescript
it("returns flag_count and relationship_count on get", async () => {
  const { memoryService, relationshipService } =
    createTestServiceWithRelationships();

  const m1 = await memoryService.create({
    workspace_id: "test-project",
    content: "Memory with counts",
    type: "fact",
    author: "alice",
  });
  assertMemory(m1.data);

  const m2 = await memoryService.create({
    workspace_id: "test-project",
    content: "Related memory for counting",
    type: "fact",
    author: "alice",
  });
  assertMemory(m2.data);

  // Create a relationship
  await relationshipService.create({
    sourceId: m1.data.id,
    targetId: m2.data.id,
    type: "refines",
    userId: "alice",
  });

  const fetched = await memoryService.get(m1.data.id, "alice");
  expect(fetched.data.flag_count).toBe(0);
  expect(fetched.data.relationship_count).toBe(1);
  expect(fetched.data.comment_count).toBe(0);
});
```

Add the `createTestServiceWithRelationships` import if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/memory-crud.test.ts -t "returns flag_count and relationship_count"`
Expected: FAIL — `flag_count` and `relationship_count` do not exist on Memory

- [ ] **Step 3: Add flag_count and relationship_count to Memory and MemorySummary types**

In `src/types/memory.ts`, add to the `Memory` interface after `comment_count`:

```typescript
flag_count: number; // computed via COUNT of open flags
relationship_count: number; // computed via COUNT of active relationships
```

Add to `MemorySummary` after `comment_count`:

```typescript
flag_count: number;
relationship_count: number;
```

Update `toSummary()` to include the new fields:

```typescript
export function toSummary(memory: Memory): MemorySummary {
  return {
    id: memory.id,
    title: memory.title,
    content: memory.content,
    type: memory.type,
    scope: memory.scope,
    tags: memory.tags,
    author: memory.author,
    source: memory.source,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    verified_at: memory.verified_at,
    verified_by: memory.verified_by,
    comment_count: memory.comment_count,
    flag_count: memory.flag_count,
    relationship_count: memory.relationship_count,
    last_comment_at: memory.last_comment_at,
  };
}
```

- [ ] **Step 4: Add correlated subqueries to memoryColumns()**

In `src/repositories/memory-repository.ts`, update `memoryColumns()`:

```typescript
  private memoryColumns() {
    return {
      ...baseMemoryColumns,
      comment_count:
        sql<number>`(SELECT COUNT(*)::int FROM comments WHERE comments.memory_id = memories.id)`.as(
          "comment_count",
        ),
      flag_count:
        sql<number>`(SELECT COUNT(*)::int FROM flags WHERE flags.memory_id = memories.id AND flags.resolved_at IS NULL)`.as(
          "flag_count",
        ),
      relationship_count:
        sql<number>`(SELECT COUNT(*)::int FROM relationships WHERE (relationships.source_id = memories.id OR relationships.target_id = memories.id) AND relationships.archived_at IS NULL)`.as(
          "relationship_count",
        ),
    };
  }
```

Add `flags` and `relationships` to the schema import at the top of the file:

```typescript
import { memories, comments, flags, relationships } from "../db/schema.js";
```

- [ ] **Step 5: Update rowToMemory to parse the new counts**

In `src/repositories/memory-repository.ts`, update `rowToMemory`:

```typescript
function rowToMemory(row: Record<string, unknown>): Memory {
  const result = { ...row } as unknown as Memory;
  // Ensure counts are numbers (PostgreSQL COUNT can return string via bigint)
  const rawCommentCount = (row as Record<string, unknown>).comment_count;
  result.comment_count =
    rawCommentCount !== undefined && rawCommentCount !== null
      ? Number(rawCommentCount)
      : 0;
  const rawFlagCount = (row as Record<string, unknown>).flag_count;
  result.flag_count =
    rawFlagCount !== undefined && rawFlagCount !== null
      ? Number(rawFlagCount)
      : 0;
  const rawRelCount = (row as Record<string, unknown>).relationship_count;
  result.relationship_count =
    rawRelCount !== undefined && rawRelCount !== null ? Number(rawRelCount) : 0;
  return result;
}
```

- [ ] **Step 6: Fix create() to set new counts to 0**

In `src/repositories/memory-repository.ts`, update the `create` method's return to include the new counts:

```typescript
return rowToMemory({
  ...result[0],
  comment_count: 0,
  flag_count: 0,
  relationship_count: 0,
});
```

Also update the `MemoryService.create()` in `src/services/memory-service.ts` where it builds `memoryData`:

```typescript
      comment_count: 0,
      flag_count: 0,
      relationship_count: 0,
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/integration/memory-crud.test.ts -t "returns flag_count and relationship_count"`
Expected: PASS

- [ ] **Step 8: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: All tests pass. Some tests may need `flag_count` and `relationship_count` added to assertions if they do exact object matching.

- [ ] **Step 9: Commit**

```bash
git add src/types/memory.ts src/repositories/memory-repository.ts src/services/memory-service.ts tests/integration/memory-crud.test.ts
git commit -m "feat: add flag_count and relationship_count correlated subqueries"
```

---

### Task 2: `memory_list` — scope as array

**Files:**

- Modify: `src/utils/validation.ts:33` (memoryScopeEnum)
- Modify: `src/repositories/types.ts:11` (ListOptions.scope)
- Modify: `src/repositories/memory-repository.ts:284-389` (list method)
- Modify: `src/services/memory-service.ts:853-872` (list method)
- Modify: `src/tools/memory-list.ts` (tool schema + description)
- Modify: `src/routes/api-schemas.ts:60-70` (toolSchemas.memory_list)
- Test: `tests/integration/memory-scoping.test.ts`

- [ ] **Step 1: Write failing test for multi-scope list**

In `tests/integration/memory-scoping.test.ts`, add:

```typescript
it("lists memories across multiple scopes", async () => {
  const service = createTestService();

  // Create workspace-scoped memory
  const ws = await service.create({
    workspace_id: "test-project",
    content: "Workspace memory for multi-scope test",
    type: "fact",
    author: "alice",
  });
  assertMemory(ws.data);

  // Create user-scoped memory
  const user = await service.create({
    workspace_id: "test-project",
    content: "User memory for multi-scope test",
    type: "fact",
    author: "alice",
    scope: "user",
  });
  assertMemory(user.data);

  // List with both scopes
  const result = await service.list({
    project_id: "test-project",
    workspace_id: "test-project",
    scope: ["workspace", "user"],
    user_id: "alice",
  });

  expect(result.data.length).toBe(2);
  const scopes = result.data.map((m) => m.scope);
  expect(scopes).toContain("workspace");
  expect(scopes).toContain("user");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/memory-scoping.test.ts -t "lists memories across multiple scopes"`
Expected: FAIL — `scope` expects a string, not an array

- [ ] **Step 3: Update ListOptions.scope to accept array**

In `src/repositories/types.ts`, change `ListOptions`:

```typescript
export interface ListOptions {
  project_id: string;
  workspace_id?: string;
  scope: Array<"workspace" | "user" | "project">;
  user_id?: string;
  type?: string;
  tags?: string[];
  sort_by?: "created_at" | "updated_at";
  order?: "asc" | "desc";
  cursor?: { created_at: string; id: string };
  limit?: number;
}
```

- [ ] **Step 4: Update repository list() for multi-scope**

In `src/repositories/memory-repository.ts`, replace the scope-filtering block in `list()` (lines 298-315) with:

```typescript
// Scope-based filtering: build OR conditions for each requested scope
const scopeConditions: SQL[] = [];
for (const s of options.scope) {
  if (s === "workspace") {
    if (!options.workspace_id) {
      throw new ValidationError(
        "workspace_id is required for workspace-scoped list",
      );
    }
    scopeConditions.push(
      and(
        eq(memories.workspace_id, options.workspace_id),
        eq(memories.scope, "workspace"),
      )!,
    );
  } else if (s === "project") {
    scopeConditions.push(eq(memories.scope, "project"));
  } else {
    // user scope
    if (!options.user_id) {
      throw new ValidationError("user_id is required for user-scoped list");
    }
    scopeConditions.push(
      and(eq(memories.author, options.user_id), eq(memories.scope, "user"))!,
    );
  }
}
// Combine scope conditions with OR; always include project-scoped if any non-project scope requested
const hasNonProjectScope = options.scope.some((s) => s !== "project");
if (hasNonProjectScope && !options.scope.includes("project")) {
  scopeConditions.push(eq(memories.scope, "project"));
}
if (scopeConditions.length === 1) {
  conditions.push(scopeConditions[0]);
} else {
  conditions.push(or(...scopeConditions)!);
}
```

- [ ] **Step 5: Update service list() to pass scope as array**

The `MemoryService.list()` method at `src/services/memory-service.ts:853` already passes `options` straight through to the repository, so no changes needed as long as the `ListOptions` type is updated.

- [ ] **Step 6: Update memory_list tool schema**

In `src/tools/memory-list.ts`, replace the `scope` field:

```typescript
        scope: z
          .array(memoryScopeEnum)
          .min(1)
          .catch(["workspace"])
          .describe(
            'Scopes to include, e.g. ["workspace", "user"]. Defaults to ["workspace"]. Project-scoped memories are always included.',
          ),
```

Update the import to include `memoryScopeEnum` from validation (already imported).

Update the tool description:

```typescript
      description:
        'Browse memories with filtering, sorting, and pagination. Supports multiple scopes in one call, e.g. scope: ["workspace", "user"]. Project-scoped memories are always included. Example: memory_list({ workspace_id: "my-project", user_id: "alice", scope: ["workspace", "user"] })',
```

- [ ] **Step 7: Update api-schemas.ts**

In `src/routes/api-schemas.ts`, update the `memory_list` schema:

```typescript
  memory_list: z.object({
    workspace_id: slugSchema.optional(),
    scope: z.array(memoryScopeEnum).min(1).default(["workspace"]),
    user_id: slugSchema,
    type: memoryTypeEnum.optional(),
    tags: z.array(z.string()).optional(),
    sort_by: z.enum(["created_at", "updated_at"]).default("created_at"),
    order: z.enum(["asc", "desc"]).default("desc"),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
```

Add `memoryScopeEnum` to the imports from validation.ts if not already there.

- [ ] **Step 8: Fix all callers that pass scope as a string**

Search the codebase for all places that call `service.list()` or `memoryRepo.list()` with `scope: "string"` and change to `scope: ["string"]`. Key locations:

- `src/services/memory-service.ts` — any internal calls to `this.memoryRepo.list()`
- `tests/integration/memory-scoping.test.ts` — existing test calls
- `tests/integration/memory-crud.test.ts` — existing test calls
- Any other test files that call `service.list()`

- [ ] **Step 9: Run test to verify multi-scope test passes**

Run: `npx vitest run tests/integration/memory-scoping.test.ts -t "lists memories across multiple scopes"`
Expected: PASS

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add src/repositories/types.ts src/repositories/memory-repository.ts src/services/memory-service.ts src/tools/memory-list.ts src/routes/api-schemas.ts tests/
git commit -m "feat: memory_list accepts scope as array for multi-scope queries"
```

---

### Task 3: `memory_get` — batch IDs with optional includes

**Files:**

- Modify: `src/repositories/comment-repository.ts` (add `findByMemoryIds`)
- Modify: `src/repositories/types.ts` (CommentRepository interface)
- Modify: `src/services/flag-service.ts` or `src/repositories/flag-repository.ts` (add `findByMemoryIds`)
- Modify: `src/repositories/types.ts` (FlagRepository interface)
- Modify: `src/services/memory-service.ts` (add `getMany()`)
- Modify: `src/tools/memory-get.ts` (tool schema + description)
- Modify: `src/routes/api-schemas.ts:30-33` (toolSchemas.memory_get)
- Test: `tests/integration/memory-crud.test.ts`

- [ ] **Step 1: Write failing test for batch get with counts only**

In `tests/integration/memory-crud.test.ts`, add:

```typescript
it("batch gets multiple memories with counts", async () => {
  const { memoryService, relationshipService } =
    createTestServiceWithRelationships();

  const m1 = await memoryService.create({
    workspace_id: "test-project",
    content: "Batch get memory one",
    type: "fact",
    author: "alice",
  });
  assertMemory(m1.data);

  const m2 = await memoryService.create({
    workspace_id: "test-project",
    content: "Batch get memory two",
    type: "decision",
    author: "alice",
  });
  assertMemory(m2.data);

  const result = await memoryService.getMany([m1.data.id, m2.data.id], "alice");

  expect(result.data).toHaveLength(2);
  expect(result.data[0].comment_count).toBe(0);
  expect(result.data[0].flag_count).toBe(0);
  expect(result.data[0].relationship_count).toBe(0);
  // Without include, should not have comments/flags/relationships arrays
  expect(result.data[0]).not.toHaveProperty("comments");
  expect(result.data[0]).not.toHaveProperty("flags");
  expect(result.data[0]).not.toHaveProperty("relationships");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/memory-crud.test.ts -t "batch gets multiple memories"`
Expected: FAIL — `getMany` does not exist

- [ ] **Step 3: Write failing test for batch get with includes**

In `tests/integration/memory-crud.test.ts`, add:

```typescript
it("batch gets with include returns full data for specified joins", async () => {
  const { memoryService, relationshipService } =
    createTestServiceWithRelationships();

  const m1 = await memoryService.create({
    workspace_id: "test-project",
    content: "Memory with relationship for include test",
    type: "fact",
    author: "alice",
  });
  assertMemory(m1.data);

  const m2 = await memoryService.create({
    workspace_id: "test-project",
    content: "Related memory for include test",
    type: "fact",
    author: "alice",
  });
  assertMemory(m2.data);

  await relationshipService.create({
    sourceId: m1.data.id,
    targetId: m2.data.id,
    type: "refines",
    userId: "alice",
  });

  const result = await memoryService.getMany([m1.data.id], "alice", [
    "relationships",
  ]);

  expect(result.data).toHaveLength(1);
  // relationships included as array
  expect(result.data[0].relationships).toHaveLength(1);
  expect(result.data[0].relationships![0].type).toBe("refines");
  // comments and flags still counts
  expect(result.data[0].comment_count).toBe(0);
  expect(result.data[0].flag_count).toBe(0);
  expect(result.data[0]).not.toHaveProperty("comments");
  expect(result.data[0]).not.toHaveProperty("flags");
});
```

- [ ] **Step 4: Add batch findByMemoryIds to CommentRepository**

In `src/repositories/comment-repository.ts`, add after `findByMemoryId`:

```typescript
  async findByMemoryIds(memoryIds: string[]): Promise<Comment[]> {
    if (memoryIds.length === 0) return [];
    const result = await this.db
      .select()
      .from(comments)
      .where(inArray(comments.memory_id, memoryIds))
      .orderBy(asc(comments.created_at));

    return result.map((row) => ({
      id: row.id,
      memory_id: row.memory_id,
      author: row.author,
      content: row.content,
      created_at: row.created_at,
    }));
  }
```

Add `inArray` to the drizzle-orm imports. Update the `CommentRepository` interface in `src/repositories/types.ts`:

```typescript
export interface CommentRepository {
  create(comment: {
    id: string;
    memory_id: string;
    author: string;
    content: string;
  }): Promise<Comment>;
  findByMemoryId(memoryId: string): Promise<Comment[]>;
  findByMemoryIds(memoryIds: string[]): Promise<Comment[]>;
  countByMemoryId(memoryId: string): Promise<number>;
}
```

- [ ] **Step 5: Add batch findByMemoryIds to FlagRepository**

In `src/repositories/flag-repository.ts`, add after `findByMemoryId`:

```typescript
  async findByMemoryIds(memoryIds: string[]): Promise<Flag[]> {
    if (memoryIds.length === 0) return [];
    return (await this.db
      .select()
      .from(flags)
      .where(inArray(flags.memory_id, memoryIds))
      .orderBy(desc(flags.created_at))) as Flag[];
  }
```

Add `inArray` to the drizzle-orm imports. Update the `FlagRepository` interface in `src/repositories/types.ts`:

```typescript
  findByMemoryIds(memoryIds: string[]): Promise<Flag[]>;
```

Add this line after `findByMemoryId` in the interface.

- [ ] **Step 6: Define MemoryGetManyResponse type**

In `src/types/memory.ts`, add after `MemoryGetResponse`:

```typescript
// Response type for batch memory_get — detail with counts, optionally expanded joins
export interface MemoryGetManyItem extends MemoryDetail {
  flag_count: number;
  relationship_count: number;
  can_comment: boolean;
  can_edit: boolean;
  can_archive: boolean;
  can_verify: boolean;
  // Optional: populated when requested via include parameter
  comments?: Comment[];
  flags?: Array<{
    flag_id: string;
    flag_type: string;
    related_memory?: {
      id: string;
      title: string;
      content: string;
      scope: string;
    } | null;
    reason: string;
  }>;
  relationships?: import("./relationship.js").RelationshipWithMemory[];
}
```

- [ ] **Step 7: Implement getMany() in MemoryService**

In `src/services/memory-service.ts`, add after the existing `getWithComments` method:

```typescript
  async getMany(
    ids: string[],
    userId: string,
    include?: Array<"comments" | "flags" | "relationships">,
  ): Promise<Envelope<MemoryGetManyItem[]>> {
    const start = Date.now();

    const allMemories = await this.memoryRepo.findByIds(ids);

    // Filter by project isolation and access control
    const accessible = allMemories.filter(
      (m) => m.project_id === this.projectId && canAccessMemory(m, userId),
    );

    const accessibleIds = accessible.map((m) => m.id);
    const includeSet = new Set(include ?? []);

    // Batch-fetch optional joins
    const [commentsByMemory, flagsByMemory, relsByMemory] = await Promise.all([
      includeSet.has("comments") && this.commentRepo
        ? this.commentRepo
            .findByMemoryIds(accessibleIds)
            .then((cs) => this.groupBy(cs, "memory_id"))
        : Promise.resolve(new Map<string, Comment[]>()),
      includeSet.has("flags") && this.flagService
        ? this.batchFetchFlags(accessibleIds)
        : Promise.resolve(
            new Map<
              string,
              MemoryGetManyItem["flags"]
            >(),
          ),
      includeSet.has("relationships") && this.relationshipService
        ? this.batchFetchRelationships(accessibleIds, userId)
        : Promise.resolve(new Map<string, RelationshipWithMemory[]>()),
    ]);

    const items: MemoryGetManyItem[] = accessible.map((memory) => {
      const isOwner = memory.author === userId;
      const isShared =
        memory.scope === "workspace" || memory.scope === "project";
      const capabilities = {
        can_edit: canAccessMemory(memory, userId),
        can_archive: canAccessMemory(memory, userId),
        can_verify: canAccessMemory(memory, userId),
        can_comment: isShared && !isOwner,
      };

      const item: MemoryGetManyItem = {
        ...toDetail(memory),
        flag_count: memory.flag_count,
        relationship_count: memory.relationship_count,
        ...capabilities,
      };

      if (includeSet.has("comments")) {
        item.comments = commentsByMemory.get(memory.id) ?? [];
      }
      if (includeSet.has("flags")) {
        item.flags = flagsByMemory.get(memory.id) ?? [];
      }
      if (includeSet.has("relationships")) {
        item.relationships = relsByMemory.get(memory.id) ?? [];
      }

      return item;
    });

    const timing = Date.now() - start;
    return { data: items, meta: { count: items.length, timing } };
  }

  private groupBy<T>(items: T[], key: keyof T & string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const k = item[key] as string;
      const arr = map.get(k);
      if (arr) {
        arr.push(item);
      } else {
        map.set(k, [item]);
      }
    }
    return map;
  }

  private async batchFetchFlags(
    memoryIds: string[],
  ): Promise<Map<string, MemoryGetManyItem["flags"]>> {
    if (!this.flagService) return new Map();
    const flagRepo = (this.flagService as { flagRepo?: FlagRepository })
      .flagRepo;
    // Use the flag service's repository to batch-fetch
    // We need to add a method to FlagService or access the repo directly
    // For now, fetch flags per memory via the existing service method
    const allFlags: Flag[] = [];
    for (const id of memoryIds) {
      const flags = await this.flagService.getFlagsByMemoryId(id);
      allFlags.push(...flags);
    }

    const map = new Map<string, MemoryGetManyItem["flags"]>();
    for (const f of allFlags) {
      if (f.resolved_at) continue;
      let relatedMem = null;
      if (f.details.related_memory_id) {
        const related = await this.memoryRepo.findById(
          f.details.related_memory_id,
        );
        if (related) {
          relatedMem = {
            id: related.id,
            title: related.title,
            content: related.content,
            scope: related.scope,
          };
        }
      }
      const entry = {
        flag_id: f.id,
        flag_type: f.flag_type,
        related_memory: relatedMem,
        reason: f.details.reason,
      };
      const arr = map.get(f.memory_id);
      if (arr) {
        arr.push(entry);
      } else {
        map.set(f.memory_id, [entry]);
      }
    }
    return map;
  }

  private async batchFetchRelationships(
    memoryIds: string[],
    userId: string,
  ): Promise<Map<string, RelationshipWithMemory[]>> {
    if (!this.relationshipService) return new Map();

    const map = new Map<string, RelationshipWithMemory[]>();
    // Fetch relationships for each memory — leverages existing access control logic
    await Promise.all(
      memoryIds.map(async (id) => {
        try {
          const rels = await this.relationshipService!.listForMemory(
            id,
            "both",
            userId,
          );
          if (rels.length > 0) {
            map.set(id, rels);
          }
        } catch {
          // Memory may have been archived/deleted between fetch and relationship lookup
        }
      }),
    );
    return map;
  }
```

Add `MemoryGetManyItem` to the imports from `../types/memory.js`. Add `Flag` type import from `../types/flag.js`. Add `FlagRepository` type import if needed.

- [ ] **Step 8: Run tests to verify getMany works**

Run: `npx vitest run tests/integration/memory-crud.test.ts -t "batch gets"`
Expected: Both batch get tests pass

- [ ] **Step 9: Update memory_get tool to accept ids array + include**

In `src/tools/memory-get.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryService } from "../services/memory-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse, withErrorHandling } from "./tool-utils.js";

export function registerMemoryGet(
  server: McpServer,
  memoryService: MemoryService,
): void {
  server.registerTool(
    "memory_get",
    {
      description:
        'Retrieve one or more memories by ID. Returns full details with comment_count, flag_count, and relationship_count. Use the include parameter to get full comments, flags, or relationships arrays instead of counts. With include: ["relationships"], there is no need to call memory_relationships separately. For the common "get all memories" flow: memory_list → memory_get. Example: memory_get({ ids: ["abc123"], user_id: "alice", include: ["comments", "relationships"] })',
      inputSchema: {
        ids: z
          .array(z.string().min(1))
          .min(1)
          .describe("Memory IDs to retrieve"),
        user_id: slugSchema.describe(
          "User identifier (e.g., 'alice'). Required for access control and capability computation.",
        ),
        include: z
          .array(z.enum(["comments", "flags", "relationships"]))
          .optional()
          .describe(
            'Optional: expand these fields to full arrays instead of counts. E.g. ["comments", "relationships"]',
          ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const result = await memoryService.getMany(
          params.ids,
          params.user_id,
          params.include,
        );
        return toolResponse(result);
      });
    },
  );
}
```

- [ ] **Step 10: Update api-schemas.ts for memory_get**

In `src/routes/api-schemas.ts`:

```typescript
  memory_get: z.object({
    ids: z.array(z.string().min(1)).min(1),
    user_id: slugSchema,
    include: z.array(z.enum(["comments", "flags", "relationships"])).optional(),
  }),
```

- [ ] **Step 11: Update api-tools.ts handler for memory_get**

Check `src/routes/api-tools.ts` — the handler for `memory_get` calls `memoryService.getWithComments(params.id, params.user_id)`. Update it to call `memoryService.getMany(params.ids, params.user_id, params.include)`.

- [ ] **Step 12: Fix any tests that call memory_get with the old single-id schema**

Search for `memory_get` usage in tests and update from `{ id: "...", user_id: "..." }` to `{ ids: ["..."], user_id: "..." }`.

- [ ] **Step 13: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 14: Commit**

```bash
git add src/repositories/comment-repository.ts src/repositories/flag-repository.ts src/repositories/types.ts src/types/memory.ts src/services/memory-service.ts src/tools/memory-get.ts src/routes/api-schemas.ts src/routes/api-tools.ts tests/
git commit -m "feat: memory_get accepts ids array with optional include for batch queries"
```

---

### Task 4: `memory_relationships` — batch memory IDs

**Files:**

- Modify: `src/repositories/relationship-repository.ts:38-73` (findByMemoryId → findByMemoryIds)
- Modify: `src/repositories/types.ts:187-192` (RelationshipRepository interface)
- Modify: `src/services/relationship-service.ts:172-219` (listForMemory → listForMemories)
- Modify: `src/tools/memory-relationships.ts` (tool schema)
- Modify: `src/routes/api-schemas.ts:114-119` (toolSchemas.memory_relationships)
- Test: `tests/integration/relationships.test.ts`

- [ ] **Step 1: Write failing test for batch relationship query**

In `tests/integration/relationships.test.ts`, add:

```typescript
it("lists relationships for multiple memories in one call", async () => {
  // Create 3 memories
  const m1 = await memoryService.create({
    workspace_id: "test-project",
    content: "Batch rel memory one",
    type: "fact",
    author: "alice",
  });
  assertMemory(m1.data);

  const m2 = await memoryService.create({
    workspace_id: "test-project",
    content: "Batch rel memory two",
    type: "fact",
    author: "alice",
  });
  assertMemory(m2.data);

  const m3 = await memoryService.create({
    workspace_id: "test-project",
    content: "Batch rel memory three",
    type: "fact",
    author: "alice",
  });
  assertMemory(m3.data);

  // Create relationships: m1→m2 and m3→m1
  await relationshipService.create({
    sourceId: m1.data.id,
    targetId: m2.data.id,
    type: "refines",
    userId: "alice",
  });
  await relationshipService.create({
    sourceId: m3.data.id,
    targetId: m1.data.id,
    type: "implements",
    userId: "alice",
  });

  // Query relationships for m1 and m3
  const result = await relationshipService.listForMemories(
    [m1.data.id, m3.data.id],
    "both",
    "alice",
  );

  // m1 has 2 relationships (outgoing to m2, incoming from m3)
  // m3 has 1 relationship (outgoing to m1)
  // Total: 3 (but m3→m1 appears in both m1's incoming and m3's outgoing, so deduped = 2 unique relationships)
  expect(result.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/relationships.test.ts -t "lists relationships for multiple memories"`
Expected: FAIL — `listForMemories` does not exist

- [ ] **Step 3: Add findByMemoryIds to RelationshipRepository**

In `src/repositories/relationship-repository.ts`, add after `findByMemoryId`:

```typescript
  async findByMemoryIds(
    projectId: string,
    memoryIds: string[],
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]> {
    if (memoryIds.length === 0) return [];
    const conditions = [
      eq(relationships.project_id, projectId),
      isNull(relationships.archived_at),
    ];

    if (direction === "outgoing") {
      conditions.push(inArray(relationships.source_id, memoryIds));
    } else if (direction === "incoming") {
      conditions.push(inArray(relationships.target_id, memoryIds));
    } else {
      conditions.push(
        or(
          inArray(relationships.source_id, memoryIds),
          inArray(relationships.target_id, memoryIds),
        )!,
      );
    }

    if (type) {
      conditions.push(eq(relationships.type, type));
    }

    const rows = await this.db
      .select()
      .from(relationships)
      .where(and(...conditions))
      .orderBy(relationships.created_at);

    return rows as Relationship[];
  }
```

Update the `RelationshipRepository` interface in `src/repositories/types.ts`:

```typescript
  findByMemoryIds(
    projectId: string,
    memoryIds: string[],
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]>;
```

- [ ] **Step 4: Add listForMemories to RelationshipService**

In `src/services/relationship-service.ts`, add after `listForMemory`:

```typescript
  async listForMemories(
    memoryIds: string[],
    direction: "outgoing" | "incoming" | "both",
    userId: string,
    type?: string,
  ): Promise<RelationshipWithMemory[]> {
    if (memoryIds.length === 0) return [];

    // Verify access to all anchor memories
    const anchorMemories = await this.memoryRepo.findByIds(memoryIds);
    const accessibleAnchors = anchorMemories.filter(
      (m) => m.project_id === this.projectId && canAccessMemory(m, userId),
    );
    const anchorIds = new Set(accessibleAnchors.map((m) => m.id));
    if (anchorIds.size === 0) return [];

    const relationships = await this.relationshipRepo.findByMemoryIds(
      this.projectId,
      [...anchorIds],
      direction,
      type,
    );

    // Collect related memory IDs (the "other end" of each relationship)
    const relatedIds = new Set<string>();
    for (const rel of relationships) {
      if (anchorIds.has(rel.source_id)) relatedIds.add(rel.target_id);
      if (anchorIds.has(rel.target_id)) relatedIds.add(rel.source_id);
    }
    // Remove anchor IDs from related (they may reference each other)
    for (const id of anchorIds) relatedIds.delete(id);

    // Batch-fetch related + anchor memories for lookup
    const allNeededIds = [...relatedIds];
    const relatedMemories = await this.memoryRepo.findByIds(allNeededIds);
    const memoryMap = new Map(
      [...accessibleAnchors, ...relatedMemories].map((m) => [m.id, m]),
    );

    const result: RelationshipWithMemory[] = [];
    for (const rel of relationships) {
      // Determine which anchor this belongs to and what the "other end" is
      const isSourceAnchor = anchorIds.has(rel.source_id);
      const isTargetAnchor = anchorIds.has(rel.target_id);

      if (isSourceAnchor) {
        const related = memoryMap.get(rel.target_id);
        if (!related || !canAccessMemory(related, userId)) continue;
        result.push(this.toRelationshipWithMemory(rel, "outgoing", related));
      }
      if (isTargetAnchor && !isSourceAnchor) {
        // Only add incoming if we didn't already add as outgoing from another anchor
        const related = memoryMap.get(rel.source_id);
        if (!related || !canAccessMemory(related, userId)) continue;
        result.push(this.toRelationshipWithMemory(rel, "incoming", related));
      }
    }
    return result;
  }
```

- [ ] **Step 5: Update memory_relationships tool**

In `src/tools/memory-relationships.ts`:

```typescript
export function registerMemoryRelationships(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.registerTool(
    "memory_relationships",
    {
      description:
        'List relationships for one or more memories. Returns all relationships in the requested direction, optionally filtered by type. Example: memory_relationships({ memory_ids: ["abc123", "def456"], user_id: "alice", direction: "both" })',
      inputSchema: {
        memory_ids: z
          .array(z.string().min(1))
          .min(1)
          .describe("Memory IDs to list relationships for"),
        direction: z
          .enum(["outgoing", "incoming", "both"])
          .default("both")
          .describe(
            'Direction to filter: "outgoing" (memory is source), "incoming" (memory is target), or "both" (default)',
          ),
        type: z
          .string()
          .optional()
          .describe("Optional relationship type filter"),
        user_id: slugSchema.describe(
          "User identifier (required for access control)",
        ),
      },
    },
    async (params) => {
      return withErrorHandling(async () => {
        const results = await relationshipService.listForMemories(
          params.memory_ids,
          params.direction,
          params.user_id,
          params.type,
        );
        return toolResponse({ data: results, meta: { count: results.length } });
      });
    },
  );
}
```

- [ ] **Step 6: Update api-schemas.ts for memory_relationships**

```typescript
  memory_relationships: z.object({
    memory_ids: z.array(z.string().min(1)).min(1),
    direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
    type: z.string().optional(),
    user_id: slugSchema,
  }),
```

- [ ] **Step 7: Update api-tools.ts handler**

Update the `memory_relationships` handler in `src/routes/api-tools.ts` to use `params.memory_ids` and call `listForMemories`.

- [ ] **Step 8: Fix existing tests using old memory_id parameter**

Search for `memory_relationships` and `memory_id` usage in tests, update to `memory_ids: [...]`.

- [ ] **Step 9: Run tests**

Run: `npx vitest run tests/integration/relationships.test.ts`
Expected: All relationship tests pass

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add src/repositories/relationship-repository.ts src/repositories/types.ts src/services/relationship-service.ts src/tools/memory-relationships.ts src/routes/api-schemas.ts src/routes/api-tools.ts tests/
git commit -m "feat: memory_relationships accepts memory_ids array for batch queries"
```

---

### Task 5: `memory_search` — scope as array

**Files:**

- Modify: `src/repositories/types.ts:21-29` (SearchOptions.scope)
- Modify: `src/repositories/memory-repository.ts:206-281` (search method)
- Modify: `src/services/memory-service.ts:608-671` (search method signature)
- Modify: `src/tools/memory-search.ts` (tool schema + description)
- Modify: `src/routes/api-schemas.ts:51-58` (toolSchemas.memory_search)
- Test: `tests/integration/memory-search.test.ts`

- [ ] **Step 1: Write failing test for multi-scope search**

In `tests/integration/memory-search.test.ts`, add:

```typescript
it("searches across multiple scopes with array", async () => {
  const service = createTestService();

  await service.create({
    workspace_id: "test-project",
    content: "Workspace search target multi-scope",
    type: "fact",
    author: "alice",
  });

  await service.create({
    workspace_id: "test-project",
    content: "User search target multi-scope",
    type: "fact",
    author: "alice",
    scope: "user",
  });

  const result = await service.search(
    "search target multi-scope",
    "test-project",
    ["workspace", "user"],
    "alice",
  );

  expect(result.data.length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/memory-search.test.ts -t "searches across multiple scopes"`
Expected: FAIL — scope parameter type mismatch

- [ ] **Step 3: Update SearchOptions.scope to array**

In `src/repositories/types.ts`, change `SearchOptions`:

```typescript
export interface SearchOptions {
  embedding: number[];
  project_id: string;
  workspace_id: string;
  scope: Array<"workspace" | "user" | "project">;
  user_id?: string;
  limit?: number;
  min_similarity?: number;
}
```

- [ ] **Step 4: Update repository search() for multi-scope**

In `src/repositories/memory-repository.ts`, replace the scope-filtering block in `search()` (lines 222-256) with:

```typescript
// Build scope conditions from array
const scopeConditions: SQL[] = [];
for (const s of options.scope) {
  if (s === "workspace") {
    scopeConditions.push(
      and(
        eq(memories.workspace_id, options.workspace_id),
        eq(memories.scope, "workspace"),
      )!,
    );
  } else if (s === "user") {
    if (!options.user_id) {
      throw new ValidationError("user_id is required for user-scoped search");
    }
    scopeConditions.push(
      and(eq(memories.author, options.user_id), eq(memories.scope, "user"))!,
    );
  } else {
    scopeConditions.push(eq(memories.scope, "project"));
  }
}
// Always include project-scoped if any non-project scope requested
const hasNonProjectScope = options.scope.some((s) => s !== "project");
if (hasNonProjectScope && !options.scope.includes("project")) {
  scopeConditions.push(eq(memories.scope, "project"));
}
if (scopeConditions.length === 1) {
  conditions.push(scopeConditions[0]);
} else {
  conditions.push(or(...scopeConditions)!);
}
```

- [ ] **Step 5: Update service search() signature**

In `src/services/memory-service.ts`, change the `search` method signature:

```typescript
  async search(
    query: string,
    workspace_id: string,
    scope: Array<"workspace" | "user" | "project">,
    user_id: string,
    limit?: number,
    min_similarity?: number,
  ): Promise<Envelope<MemorySummaryWithRelevance[]>> {
```

The body passes `scope` through to the repository, so no other changes needed in the method body.

- [ ] **Step 6: Update memory_search tool**

In `src/tools/memory-search.ts`, update the schema:

```typescript
        scope: z
          .array(memoryScopeEnum)
          .min(1)
          .catch(["workspace"])
          .describe(
            'Scopes to search, e.g. ["workspace", "user"]. Defaults to ["workspace"]. Project-scoped memories are always included.',
          ),
```

Update the description:

```typescript
      description:
        'Search memories by semantic similarity. Supports multiple scopes, e.g. scope: ["workspace", "user"]. Project-scoped memories are always included. Example: memory_search({ workspace_id: "my-project", query: "database migration", user_id: "alice", scope: ["workspace", "user"] })',
```

Add `memoryScopeEnum` import from `../utils/validation.js`.

- [ ] **Step 7: Update api-schemas.ts for memory_search**

```typescript
  memory_search: z.object({
    query: z.string().min(1),
    workspace_id: slugSchema,
    scope: z.array(memoryScopeEnum).min(1).default(["workspace"]),
    user_id: slugSchema,
    limit: z.number().int().min(1).max(100).default(10),
    min_similarity: z.number().min(0).max(1).default(0.3),
  }),
```

- [ ] **Step 8: Fix all callers that pass scope as a string**

Search for `service.search(` in tests and update scope from `"workspace"` / `"user"` / `"both"` to `["workspace"]` / `["user"]` / `["workspace", "user"]`.

Also update the `search` call in `src/services/memory-service.ts` `sessionStart()` method — it calls `this.search(...)` internally with `"both"`. Change to `["workspace", "user"]`.

- [ ] **Step 9: Run tests**

Run: `npx vitest run tests/integration/memory-search.test.ts`
Expected: All search tests pass

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add src/repositories/types.ts src/repositories/memory-repository.ts src/services/memory-service.ts src/tools/memory-search.ts src/routes/api-schemas.ts tests/
git commit -m "feat: memory_search accepts scope as array, drop 'both' option"
```

---

### Task 6: Final integration test + cleanup

**Files:**

- Test: `tests/integration/memory-crud.test.ts`
- Modify: Any remaining test files with old parameter shapes

- [ ] **Step 1: Write end-to-end test for the 2-call pattern**

In `tests/integration/memory-crud.test.ts`, add:

```typescript
it("supports the 2-call list→get pattern", async () => {
  const { memoryService, relationshipService } =
    createTestServiceWithRelationships();

  // Create memories across scopes
  const m1 = await memoryService.create({
    workspace_id: "test-project",
    content: "E2E test workspace memory",
    type: "fact",
    author: "alice",
  });
  assertMemory(m1.data);

  const m2 = await memoryService.create({
    workspace_id: "test-project",
    content: "E2E test user memory",
    type: "decision",
    author: "alice",
    scope: "user",
  });
  assertMemory(m2.data);

  // Step 1: List across scopes
  const listResult = await memoryService.list({
    project_id: "test-project",
    workspace_id: "test-project",
    scope: ["workspace", "user"],
    user_id: "alice",
  });
  expect(listResult.data.length).toBe(2);

  // Step 2: Get full details for all listed IDs
  const ids = listResult.data.map((m) => m.id);
  const getResult = await memoryService.getMany(ids, "alice", [
    "relationships",
  ]);
  expect(getResult.data.length).toBe(2);
  expect(getResult.data[0]).toHaveProperty("can_edit");
  expect(getResult.data[0]).toHaveProperty("relationships");
  expect(getResult.data[0]).toHaveProperty("flag_count");
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/memory-crud.test.ts -t "supports the 2-call list"`
Expected: PASS

- [ ] **Step 3: Run full test suite one final time**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: add end-to-end test for list→get batch query pattern"
```
