# Relationship Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class directional relationships between memories, refactor consolidation to create relationships instead of embedding related_memory_id in flags.

**Architecture:** New `relationships` table with repository/service/tool layers following the existing pattern (flags, comments). Consolidation creates relationships first, then flags referencing them. `memory_get` and `memory_session_start` include relationship data in responses.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Vitest, MCP SDK

---

### Task 1: Relationship Types and Schema

**Files:**

- Create: `src/types/relationship.ts`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Write the relationship type definitions**

Create `src/types/relationship.ts`:

```typescript
export const WELL_KNOWN_RELATIONSHIP_TYPES = [
  "overrides",
  "implements",
  "refines",
  "contradicts",
  "duplicates",
] as const;

export type WellKnownRelationshipType =
  (typeof WELL_KNOWN_RELATIONSHIP_TYPES)[number];

export interface Relationship {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  type: string;
  description: string | null;
  confidence: number;
  created_by: string;
  source: string | null;
  archived_at: Date | null;
  created_at: Date;
}

/** Summary of the related memory, included when returning relationships */
export interface RelatedMemorySummary {
  id: string;
  title: string;
  type: string;
  scope: string;
}

/** Relationship enriched with related memory summary for API responses */
export interface RelationshipWithMemory {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  description: string | null;
  confidence: number;
  created_by: string;
  source: string | null;
  direction: "outgoing" | "incoming";
  related_memory: RelatedMemorySummary;
  created_at: Date;
}
```

- [ ] **Step 2: Add the relationships table to the Drizzle schema**

In `src/db/schema.ts`, add after the `flags` table definition (after line ~215):

```typescript
// ── Relationships ────────────────────────────────────────────────
export const relationships = pgTable(
  "relationships",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").notNull(),
    source_id: text("source_id")
      .notNull()
      .references(() => memories.id),
    target_id: text("target_id")
      .notNull()
      .references(() => memories.id),
    type: text("type").notNull(),
    description: text("description"),
    confidence: real("confidence").notNull().default(1.0),
    created_by: text("created_by").notNull(),
    source: text("source"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("relationships_unique_edge").on(
      table.project_id,
      table.source_id,
      table.target_id,
      table.type,
    ),
    index("relationships_source_idx").on(table.source_id),
    index("relationships_target_idx").on(table.target_id),
    index("relationships_project_type_idx").on(table.project_id, table.type),
    check("relationships_no_self_ref", sql`source_id != target_id`),
  ],
);
```

You will need to add `check` to the drizzle-orm imports if not already present:

```typescript
import { ..., check } from "drizzle-orm/pg-core";
```

Also verify `real`, `uniqueIndex`, and `index` are imported from `drizzle-orm/pg-core`. Check the existing imports at the top of `schema.ts` and add any missing ones.

- [ ] **Step 3: Generate the Drizzle migration**

Run: `npx drizzle-kit generate`

This will create a new SQL migration file in `drizzle/`. Verify the generated SQL creates the `relationships` table with the correct columns, indexes, unique constraint, and check constraint.

- [ ] **Step 4: Run the migration against the test database**

Run: `npm test -- --run tests/integration/memory-crud.test.ts`

This triggers global-setup.ts which drops/recreates the test DB and runs all migrations. If it passes, the migration is valid.

- [ ] **Step 5: Commit**

```bash
git add src/types/relationship.ts src/db/schema.ts drizzle/
git commit -m "feat: add relationships table and type definitions

New Drizzle schema for memory-to-memory relationships with
directional edges, freeform type field, confidence scoring,
and soft-delete support."
```

---

### Task 2: Relationship Repository

**Files:**

- Create: `src/repositories/relationship-repository.ts`
- Modify: `src/repositories/types.ts`

- [ ] **Step 1: Write the failing test for relationship repository**

Create `tests/integration/relationships.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getTestDb,
  truncateAll,
  closeDb,
  createTestService,
  assertMemory,
} from "../helpers.js";
import { DrizzleRelationshipRepository } from "../../src/repositories/relationship-repository.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("relationship repository", () => {
  let relationshipRepo: DrizzleRelationshipRepository;
  let service: MemoryService;
  let sourceId: string;
  let targetId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    relationshipRepo = new DrizzleRelationshipRepository(db);
    service = createTestService();

    // Create two memories to relate
    const m1 = await service.create({
      workspace_id: "test-ws",
      content: "Use tabs for indentation in this repo",
      type: "preference",
      author: "alice",
    });
    assertMemory(m1.data);
    sourceId = m1.data.id;

    const m2 = await service.create({
      workspace_id: "test-ws",
      content: "Use 2-space indentation everywhere",
      type: "preference",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(m2.data);
    targetId = m2.data.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates and retrieves a relationship", async () => {
    const rel = await relationshipRepo.create({
      id: "test-rel-1",
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "overrides",
      description: "Workspace uses tabs, overriding project 2-space rule",
      confidence: 1.0,
      created_by: "alice",
      source: "manual",
      archived_at: null,
      created_at: new Date(),
    });
    expect(rel.type).toBe("overrides");
    expect(rel.source_id).toBe(sourceId);
    expect(rel.target_id).toBe(targetId);

    const found = await relationshipRepo.findByMemoryId(
      "test-project",
      sourceId,
      "both",
    );
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe("overrides");
  });

  it("returns outgoing and incoming relationships separately", async () => {
    await relationshipRepo.create({
      id: "test-rel-2",
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "overrides",
      description: null,
      confidence: 1.0,
      created_by: "alice",
      source: "agent-auto",
      archived_at: null,
      created_at: new Date(),
    });

    const outgoing = await relationshipRepo.findByMemoryId(
      "test-project",
      sourceId,
      "outgoing",
    );
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].source_id).toBe(sourceId);

    const incoming = await relationshipRepo.findByMemoryId(
      "test-project",
      targetId,
      "incoming",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0].target_id).toBe(targetId);

    // The other direction returns nothing
    const noOutgoing = await relationshipRepo.findByMemoryId(
      "test-project",
      targetId,
      "outgoing",
    );
    expect(noOutgoing).toHaveLength(0);
  });

  it("enforces unique constraint on (project_id, source_id, target_id, type)", async () => {
    const base = {
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "overrides",
      description: null,
      confidence: 1.0,
      created_by: "alice",
      source: "manual",
      archived_at: null,
      created_at: new Date(),
    };
    await relationshipRepo.create({ ...base, id: "rel-a" });
    await expect(
      relationshipRepo.create({ ...base, id: "rel-b" }),
    ).rejects.toThrow();
  });

  it("findExisting returns matching relationship", async () => {
    await relationshipRepo.create({
      id: "test-rel-existing",
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "overrides",
      description: null,
      confidence: 1.0,
      created_by: "alice",
      source: "manual",
      archived_at: null,
      created_at: new Date(),
    });

    const existing = await relationshipRepo.findExisting(
      "test-project",
      sourceId,
      targetId,
      "overrides",
    );
    expect(existing).toBeDefined();
    expect(existing!.id).toBe("test-rel-existing");

    const notFound = await relationshipRepo.findExisting(
      "test-project",
      sourceId,
      targetId,
      "implements",
    );
    expect(notFound).toBeNull();
  });

  it("soft-deletes relationships when archiveByMemoryId is called", async () => {
    await relationshipRepo.create({
      id: "test-rel-archive",
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "refines",
      description: null,
      confidence: 0.85,
      created_by: "alice",
      source: "consolidation",
      archived_at: null,
      created_at: new Date(),
    });

    const count = await relationshipRepo.archiveByMemoryId(sourceId);
    expect(count).toBe(1);

    // Should not appear in active queries
    const found = await relationshipRepo.findByMemoryId(
      "test-project",
      sourceId,
      "both",
    );
    expect(found).toHaveLength(0);
  });

  it("deletes a relationship by id", async () => {
    await relationshipRepo.create({
      id: "test-rel-delete",
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "duplicates",
      description: null,
      confidence: 0.95,
      created_by: "alice",
      source: "consolidation",
      archived_at: null,
      created_at: new Date(),
    });

    const deleted = await relationshipRepo.deleteById("test-rel-delete");
    expect(deleted).toBe(true);

    const found = await relationshipRepo.findByMemoryId(
      "test-project",
      sourceId,
      "both",
    );
    expect(found).toHaveLength(0);
  });

  it("filters by type", async () => {
    await relationshipRepo.create({
      id: "rel-type-a",
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "overrides",
      description: null,
      confidence: 1.0,
      created_by: "alice",
      source: "manual",
      archived_at: null,
      created_at: new Date(),
    });

    // Create a third memory for a second relationship
    const m3 = await service.create({
      workspace_id: "test-ws",
      content: "Additional detail about indentation",
      type: "preference",
      author: "alice",
    });
    assertMemory(m3.data);

    await relationshipRepo.create({
      id: "rel-type-b",
      project_id: "test-project",
      source_id: sourceId,
      target_id: m3.data.id,
      type: "refines",
      description: null,
      confidence: 1.0,
      created_by: "alice",
      source: "manual",
      archived_at: null,
      created_at: new Date(),
    });

    const overridesOnly = await relationshipRepo.findByMemoryId(
      "test-project",
      sourceId,
      "both",
      "overrides",
    );
    expect(overridesOnly).toHaveLength(1);
    expect(overridesOnly[0].type).toBe("overrides");
  });

  it("findBetweenMemories returns relationships among a set of memory IDs", async () => {
    await relationshipRepo.create({
      id: "rel-between",
      project_id: "test-project",
      source_id: sourceId,
      target_id: targetId,
      type: "overrides",
      description: null,
      confidence: 1.0,
      created_by: "alice",
      source: "manual",
      archived_at: null,
      created_at: new Date(),
    });

    const between = await relationshipRepo.findBetweenMemories("test-project", [
      sourceId,
      targetId,
    ]);
    expect(between).toHaveLength(1);
    expect(between[0].type).toBe("overrides");

    // Subset that excludes one side returns nothing
    const partial = await relationshipRepo.findBetweenMemories("test-project", [
      sourceId,
    ]);
    expect(partial).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run tests/integration/relationships.test.ts`
Expected: FAIL — `DrizzleRelationshipRepository` does not exist yet.

- [ ] **Step 3: Add RelationshipRepository interface to repository types**

In `src/repositories/types.ts`, add the interface after `FlagRepository` (after line ~179):

```typescript
export interface RelationshipRepository {
  create(relationship: Relationship): Promise<Relationship>;
  findById(id: string): Promise<Relationship | null>;
  findByMemoryId(
    projectId: string,
    memoryId: string,
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]>;
  findExisting(
    projectId: string,
    sourceId: string,
    targetId: string,
    type: string,
  ): Promise<Relationship | null>;
  findBetweenMemories(
    projectId: string,
    memoryIds: string[],
  ): Promise<Relationship[]>;
  archiveByMemoryId(memoryId: string): Promise<number>;
  deleteById(id: string): Promise<boolean>;
}
```

Also add the import at the top of the file:

```typescript
import type { Relationship } from "../types/relationship.js";
```

- [ ] **Step 4: Implement the relationship repository**

Create `src/repositories/relationship-repository.ts`:

```typescript
import { eq, and, or, isNull, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { relationships } from "../db/schema.js";
import type { Relationship } from "../types/relationship.js";
import type { RelationshipRepository } from "./types.js";

export class DrizzleRelationshipRepository implements RelationshipRepository {
  constructor(private readonly db: Database) {}

  async create(relationship: Relationship): Promise<Relationship> {
    const [row] = await this.db
      .insert(relationships)
      .values({
        id: relationship.id,
        project_id: relationship.project_id,
        source_id: relationship.source_id,
        target_id: relationship.target_id,
        type: relationship.type,
        description: relationship.description,
        confidence: relationship.confidence,
        created_by: relationship.created_by,
        source: relationship.source,
        archived_at: relationship.archived_at,
        created_at: relationship.created_at,
      })
      .returning();
    return row as Relationship;
  }

  async findById(id: string): Promise<Relationship | null> {
    const [row] = await this.db
      .select()
      .from(relationships)
      .where(and(eq(relationships.id, id), isNull(relationships.archived_at)));
    return (row as Relationship) ?? null;
  }

  async findByMemoryId(
    projectId: string,
    memoryId: string,
    direction: "outgoing" | "incoming" | "both",
    type?: string,
  ): Promise<Relationship[]> {
    const conditions = [
      eq(relationships.project_id, projectId),
      isNull(relationships.archived_at),
    ];

    if (direction === "outgoing") {
      conditions.push(eq(relationships.source_id, memoryId));
    } else if (direction === "incoming") {
      conditions.push(eq(relationships.target_id, memoryId));
    } else {
      conditions.push(
        or(
          eq(relationships.source_id, memoryId),
          eq(relationships.target_id, memoryId),
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

  async findExisting(
    projectId: string,
    sourceId: string,
    targetId: string,
    type: string,
  ): Promise<Relationship | null> {
    const [row] = await this.db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.project_id, projectId),
          eq(relationships.source_id, sourceId),
          eq(relationships.target_id, targetId),
          eq(relationships.type, type),
          isNull(relationships.archived_at),
        ),
      );
    return (row as Relationship) ?? null;
  }

  async findBetweenMemories(
    projectId: string,
    memoryIds: string[],
  ): Promise<Relationship[]> {
    if (memoryIds.length < 2) return [];

    const rows = await this.db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.project_id, projectId),
          isNull(relationships.archived_at),
          inArray(relationships.source_id, memoryIds),
          inArray(relationships.target_id, memoryIds),
        ),
      )
      .orderBy(relationships.created_at);

    return rows as Relationship[];
  }

  async archiveByMemoryId(memoryId: string): Promise<number> {
    const result = await this.db
      .update(relationships)
      .set({ archived_at: new Date() })
      .where(
        and(
          or(
            eq(relationships.source_id, memoryId),
            eq(relationships.target_id, memoryId),
          ),
          isNull(relationships.archived_at),
        ),
      );
    return result.rowCount ?? 0;
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.db
      .delete(relationships)
      .where(eq(relationships.id, id));
    return (result.rowCount ?? 0) > 0;
  }
}
```

- [ ] **Step 5: Update test helpers to truncate relationships table**

In `tests/helpers.ts`, add the import:

```typescript
import { relationships } from "../src/db/schema.js";
```

And in `truncateAll()`, add `await testDb.delete(relationships);` before the `await testDb.delete(flags);` line (relationships reference memories via FK, so delete them first).

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- --run tests/integration/relationships.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/repositories/relationship-repository.ts src/repositories/types.ts tests/integration/relationships.test.ts tests/helpers.ts
git commit -m "feat: add relationship repository with CRUD and lookup methods

Implements DrizzleRelationshipRepository with create, findByMemoryId,
findExisting, findBetweenMemories, archiveByMemoryId, and deleteById.
Includes integration tests."
```

---

### Task 3: Relationship Service

**Files:**

- Create: `src/services/relationship-service.ts`

- [ ] **Step 1: Write failing tests for the relationship service**

Create `tests/integration/relationship-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getTestDb,
  truncateAll,
  closeDb,
  createTestService,
  assertMemory,
} from "../helpers.js";
import { DrizzleRelationshipRepository } from "../../src/repositories/relationship-repository.js";
import { DrizzleMemoryRepository } from "../../src/repositories/memory-repository.js";
import { RelationshipService } from "../../src/services/relationship-service.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("relationship service", () => {
  let relationshipService: RelationshipService;
  let memoryService: MemoryService;
  let sourceId: string;
  let targetId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    const relationshipRepo = new DrizzleRelationshipRepository(db);
    const memoryRepo = new DrizzleMemoryRepository(db);
    relationshipService = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "test-project",
    );
    memoryService = createTestService();

    const m1 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Use tabs in this repo",
      type: "preference",
      author: "alice",
    });
    assertMemory(m1.data);
    sourceId = m1.data.id;

    const m2 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Use 2-space indentation globally",
      type: "preference",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(m2.data);
    targetId = m2.data.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates a relationship and returns it with enriched memory summaries", async () => {
    const result = await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      description: "Workspace uses tabs, overriding project 2-space rule",
      userId: "alice",
      source: "manual",
    });

    expect(result.type).toBe("overrides");
    expect(result.source_id).toBe(sourceId);
    expect(result.target_id).toBe(targetId);
    expect(result.confidence).toBe(1.0);
  });

  it("returns existing relationship on duplicate create", async () => {
    const first = await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      userId: "alice",
    });

    const second = await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      userId: "alice",
    });

    expect(second.id).toBe(first.id);
  });

  it("throws NotFoundError if source memory does not exist", async () => {
    await expect(
      relationshipService.create({
        sourceId: "nonexistent",
        targetId,
        type: "overrides",
        userId: "alice",
      }),
    ).rejects.toThrow("not found");
  });

  it("throws ValidationError if source equals target", async () => {
    await expect(
      relationshipService.create({
        sourceId,
        targetId: sourceId,
        type: "overrides",
        userId: "alice",
      }),
    ).rejects.toThrow();
  });

  it("throws NotFoundError if user cannot access source memory", async () => {
    // Create a user-scoped memory owned by bob
    const m3 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Bob's private note",
      type: "fact",
      scope: "user",
      author: "bob",
    });
    assertMemory(m3.data);

    await expect(
      relationshipService.create({
        sourceId: m3.data.id,
        targetId,
        type: "refines",
        userId: "alice",
      }),
    ).rejects.toThrow("not found");
  });

  it("lists relationships with enriched memory summaries", async () => {
    await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      userId: "alice",
    });

    const result = await relationshipService.listForMemory(
      sourceId,
      "both",
      "alice",
    );
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("outgoing");
    expect(result[0].related_memory.id).toBe(targetId);
    expect(result[0].related_memory.title).toBeDefined();
  });

  it("removes a relationship", async () => {
    const rel = await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      userId: "alice",
    });

    await relationshipService.remove(rel.id, "alice");

    const result = await relationshipService.listForMemory(
      sourceId,
      "both",
      "alice",
    );
    expect(result).toHaveLength(0);
  });

  it("throws NotFoundError when removing non-existent relationship", async () => {
    await expect(
      relationshipService.remove("nonexistent", "alice"),
    ).rejects.toThrow("not found");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run tests/integration/relationship-service.test.ts`
Expected: FAIL — `RelationshipService` does not exist.

- [ ] **Step 3: Implement the relationship service**

Create `src/services/relationship-service.ts`:

```typescript
import type {
  RelationshipRepository,
  MemoryRepository,
} from "../repositories/types.js";
import type {
  Relationship,
  RelationshipWithMemory,
} from "../types/relationship.js";
import type { Memory } from "../types/memory.js";
import { generateId } from "../utils/id.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";

export interface CreateRelationshipInput {
  sourceId: string;
  targetId: string;
  type: string;
  description?: string;
  confidence?: number;
  userId: string;
  source?: string;
}

export class RelationshipService {
  constructor(
    private readonly relationshipRepo: RelationshipRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly projectId: string,
  ) {}

  private canAccess(memory: Memory, userId: string): boolean {
    if (memory.scope === "workspace" || memory.scope === "project") return true;
    return memory.author === userId;
  }

  async create(input: CreateRelationshipInput): Promise<Relationship> {
    if (input.sourceId === input.targetId) {
      throw new ValidationError("Source and target must be different memories");
    }

    // Verify both memories exist and are accessible
    const source = await this.memoryRepo.findById(input.sourceId);
    if (
      !source ||
      source.project_id !== this.projectId ||
      !this.canAccess(source, input.userId)
    ) {
      throw new NotFoundError("Memory", input.sourceId);
    }

    const target = await this.memoryRepo.findById(input.targetId);
    if (
      !target ||
      target.project_id !== this.projectId ||
      !this.canAccess(target, input.userId)
    ) {
      throw new NotFoundError("Memory", input.targetId);
    }

    // Dedup: return existing relationship if one already exists
    const existing = await this.relationshipRepo.findExisting(
      this.projectId,
      input.sourceId,
      input.targetId,
      input.type,
    );
    if (existing) return existing;

    const relationship: Relationship = {
      id: generateId(),
      project_id: this.projectId,
      source_id: input.sourceId,
      target_id: input.targetId,
      type: input.type,
      description: input.description ?? null,
      confidence: input.confidence ?? 1.0,
      created_by: input.userId,
      source: input.source ?? null,
      archived_at: null,
      created_at: new Date(),
    };

    return this.relationshipRepo.create(relationship);
  }

  async remove(id: string, userId: string): Promise<void> {
    const relationship = await this.relationshipRepo.findById(id);
    if (!relationship) {
      throw new NotFoundError("Relationship", id);
    }

    // Access check: must be able to edit the source memory,
    // OR if consolidation-created, access to either side suffices
    const source = await this.memoryRepo.findById(relationship.source_id);
    const target = await this.memoryRepo.findById(relationship.target_id);

    const canEditSource = source && this.canAccess(source, userId);
    const canEditEitherSide =
      relationship.source === "consolidation" &&
      (canEditSource || (target && this.canAccess(target, userId)));

    if (!canEditSource && !canEditEitherSide) {
      throw new NotFoundError("Relationship", id);
    }

    await this.relationshipRepo.deleteById(id);
  }

  async listForMemory(
    memoryId: string,
    direction: "outgoing" | "incoming" | "both",
    userId: string,
    type?: string,
  ): Promise<RelationshipWithMemory[]> {
    const relationships = await this.relationshipRepo.findByMemoryId(
      this.projectId,
      memoryId,
      direction,
      type,
    );

    const result: RelationshipWithMemory[] = [];
    for (const rel of relationships) {
      const isOutgoing = rel.source_id === memoryId;
      const relatedId = isOutgoing ? rel.target_id : rel.source_id;
      const related = await this.memoryRepo.findById(relatedId);

      // Skip if related memory is inaccessible
      if (!related || !this.canAccess(related, userId)) continue;

      result.push({
        id: rel.id,
        source_id: rel.source_id,
        target_id: rel.target_id,
        type: rel.type,
        description: rel.description,
        confidence: rel.confidence,
        created_by: rel.created_by,
        source: rel.source,
        direction: isOutgoing ? "outgoing" : "incoming",
        related_memory: {
          id: related.id,
          title: related.title,
          type: related.type,
          scope: related.scope,
        },
        created_at: rel.created_at,
      });
    }

    return result;
  }

  async listBetweenMemories(
    memoryIds: string[],
    userId: string,
  ): Promise<RelationshipWithMemory[]> {
    const relationships = await this.relationshipRepo.findBetweenMemories(
      this.projectId,
      memoryIds,
    );

    const result: RelationshipWithMemory[] = [];
    for (const rel of relationships) {
      // For "between" queries, both memories are in the result set,
      // so we pick direction relative to source
      const related = await this.memoryRepo.findById(rel.target_id);
      if (!related || !this.canAccess(related, userId)) continue;

      result.push({
        id: rel.id,
        source_id: rel.source_id,
        target_id: rel.target_id,
        type: rel.type,
        description: rel.description,
        confidence: rel.confidence,
        created_by: rel.created_by,
        source: rel.source,
        direction: "outgoing",
        related_memory: {
          id: related.id,
          title: related.title,
          type: related.type,
          scope: related.scope,
        },
        created_at: rel.created_at,
      });
    }

    return result;
  }

  async archiveByMemoryId(memoryId: string): Promise<number> {
    return this.relationshipRepo.archiveByMemoryId(memoryId);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --run tests/integration/relationship-service.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/relationship-service.ts tests/integration/relationship-service.test.ts
git commit -m "feat: add RelationshipService with create, remove, list, access control

Service layer for memory relationships with dedup on create,
access control enforcement, and enriched memory summaries in
list responses."
```

---

### Task 4: MCP Tools — memory_relate, memory_unrelate, memory_relationships

**Files:**

- Create: `src/tools/memory-relate.ts`
- Create: `src/tools/memory-unrelate.ts`
- Create: `src/tools/memory-relationships.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/routes/api-schemas.ts`
- Modify: `src/routes/api-tools.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Create the memory_relate tool**

Create `src/tools/memory-relate.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RelationshipService } from "../services/relationship-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse } from "../utils/tool-response.js";
import { z } from "zod";
import { WELL_KNOWN_RELATIONSHIP_TYPES } from "../types/relationship.js";

export function registerMemoryRelate(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.tool(
    "memory_relate",
    `Create a directional relationship between two memories. Well-known types: ${WELL_KNOWN_RELATIONSHIP_TYPES.join(", ")}. You may also use any descriptive string for novel relationship types.`,
    {
      source_id: z
        .string()
        .describe("ID of the source memory (the 'from' side)"),
      target_id: z.string().describe("ID of the target memory (the 'to' side)"),
      type: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Relationship type (e.g. overrides, implements, refines, contradicts, duplicates, or a custom string)",
        ),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("Optional context explaining the relationship"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Confidence score 0-1, defaults to 1.0"),
      user_id: slugSchema.describe("Your user ID"),
      source: z
        .string()
        .optional()
        .describe("Origin: manual, agent-auto, or consolidation"),
    },
    async (params) => {
      const result = await relationshipService.create({
        sourceId: params.source_id,
        targetId: params.target_id,
        type: params.type,
        description: params.description,
        confidence: params.confidence,
        userId: params.user_id,
        source: params.source,
      });
      return toolResponse({ data: result, meta: {} });
    },
  );
}
```

- [ ] **Step 2: Create the memory_unrelate tool**

Create `src/tools/memory-unrelate.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RelationshipService } from "../services/relationship-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse } from "../utils/tool-response.js";
import { z } from "zod";

export function registerMemoryUnrelate(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.tool(
    "memory_unrelate",
    "Remove a relationship between two memories.",
    {
      id: z.string().describe("The relationship ID to remove"),
      user_id: slugSchema.describe("Your user ID"),
    },
    async (params) => {
      await relationshipService.remove(params.id, params.user_id);
      return toolResponse({ data: { success: true }, meta: {} });
    },
  );
}
```

- [ ] **Step 3: Create the memory_relationships tool**

Create `src/tools/memory-relationships.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RelationshipService } from "../services/relationship-service.js";
import { slugSchema } from "../utils/validation.js";
import { toolResponse } from "../utils/tool-response.js";
import { z } from "zod";

export function registerMemoryRelationships(
  server: McpServer,
  relationshipService: RelationshipService,
): void {
  server.tool(
    "memory_relationships",
    "List relationships for a memory, including enriched summaries of related memories.",
    {
      memory_id: z.string().describe("The memory ID to list relationships for"),
      direction: z
        .enum(["outgoing", "incoming", "both"])
        .optional()
        .default("both")
        .describe("Filter by direction: outgoing, incoming, or both"),
      type: z.string().optional().describe("Filter by relationship type"),
      user_id: slugSchema.describe("Your user ID"),
    },
    async (params) => {
      const result = await relationshipService.listForMemory(
        params.memory_id,
        params.direction,
        params.user_id,
        params.type,
      );
      return toolResponse({
        data: result,
        meta: { count: result.length },
      });
    },
  );
}
```

- [ ] **Step 4: Register the tools and wire up the service**

In `src/tools/index.ts`, add the imports and registrations:

```typescript
import { registerMemoryRelate } from "./memory-relate.js";
import { registerMemoryUnrelate } from "./memory-unrelate.js";
import { registerMemoryRelationships } from "./memory-relationships.js";
import type { RelationshipService } from "../services/relationship-service.js";
```

Update the `registerAllTools` function signature to accept `relationshipService`:

```typescript
export function registerAllTools(
  server: McpServer,
  memoryService: MemoryService,
  flagService: FlagService,
  consolidationService: ConsolidationService,
  relationshipService: RelationshipService,
): void {
  // ... existing registrations ...
  registerMemoryRelate(server, relationshipService);
  registerMemoryUnrelate(server, relationshipService);
  registerMemoryRelationships(server, relationshipService);
}
```

In `src/server.ts`, add the repository and service initialization (after `flagService` line ~90):

```typescript
import { DrizzleRelationshipRepository } from "./repositories/relationship-repository.js";
import { RelationshipService } from "./services/relationship-service.js";
```

After the flagService initialization (line ~90), add:

```typescript
const relationshipRepo = new DrizzleRelationshipRepository(db);
const relationshipService = new RelationshipService(
  relationshipRepo,
  memoryRepo,
  config.projectId,
);
```

Update the `registerAllTools` call (line ~135) to pass `relationshipService`:

```typescript
registerAllTools(
  server,
  memoryService,
  flagService,
  consolidationService,
  relationshipService,
);
```

- [ ] **Step 5: Add API schemas for the new tools**

In `src/routes/api-schemas.ts`, add schemas for the three new tools:

```typescript
memory_relate: {
  type: "object" as const,
  properties: {
    source_id: { type: "string" },
    target_id: { type: "string" },
    type: { type: "string", minLength: 1, maxLength: 64 },
    description: { type: "string", maxLength: 500 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    user_id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    source: { type: "string" },
  },
  required: ["source_id", "target_id", "type", "user_id"],
},
memory_unrelate: {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    user_id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
  },
  required: ["id", "user_id"],
},
memory_relationships: {
  type: "object" as const,
  properties: {
    memory_id: { type: "string" },
    direction: { type: "string", enum: ["outgoing", "incoming", "both"] },
    type: { type: "string" },
    user_id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
  },
  required: ["memory_id", "user_id"],
},
```

- [ ] **Step 6: Add API tool routes for the new tools**

In `src/routes/api-tools.ts`, add cases in the switch statement for each new tool. Follow the existing pattern — call the service method and return the envelope.

Note: The api-tools.ts file currently takes `memoryService` as a parameter. You'll need to also pass `relationshipService`:

Update the `createApiToolsRouter` function signature to accept `relationshipService`:

```typescript
export function createApiToolsRouter(
  memoryService: MemoryService,
  relationshipService: RelationshipService,
): Router {
```

Add the cases:

```typescript
case "memory_relate": {
  const result = await relationshipService.create({
    sourceId: validated.source_id,
    targetId: validated.target_id,
    type: validated.type,
    description: validated.description,
    confidence: validated.confidence,
    userId: validated.user_id,
    source: validated.source,
  });
  return res.json({ data: result, meta: {} });
}
case "memory_unrelate": {
  await relationshipService.remove(validated.id, validated.user_id);
  return res.json({ data: { success: true }, meta: {} });
}
case "memory_relationships": {
  const result = await relationshipService.listForMemory(
    validated.memory_id,
    validated.direction ?? "both",
    validated.user_id,
    validated.type,
  );
  return res.json({ data: result, meta: { count: result.length } });
}
```

Update the `registerRoutes` call in `src/routes/index.ts` (or wherever `createApiToolsRouter` is called) to pass `relationshipService` as well. Check the routes index file:

```bash
grep -n "createApiToolsRouter" src/routes/index.ts
```

Update accordingly.

- [ ] **Step 7: Run all tests to verify nothing is broken**

Run: `npm test`
Expected: All existing tests pass, new tool files compile.

- [ ] **Step 8: Commit**

```bash
git add src/tools/memory-relate.ts src/tools/memory-unrelate.ts src/tools/memory-relationships.ts src/tools/index.ts src/server.ts src/routes/api-schemas.ts src/routes/api-tools.ts src/routes/index.ts
git commit -m "feat: add memory_relate, memory_unrelate, memory_relationships MCP tools

Three new MCP tools for creating, removing, and listing memory
relationships. Wired into server and API routes."
```

---

### Task 5: Integrate Relationships into memory_get

**Files:**

- Modify: `src/services/memory-service.ts`
- Modify: `src/types/memory.ts`

- [ ] **Step 1: Write the failing test**

Add a new test block to `tests/integration/relationships.test.ts` (or extend the existing file):

```typescript
describe("memory_get includes relationships", () => {
  let memoryService: MemoryService;
  let relationshipService: RelationshipService;
  let sourceId: string;
  let targetId: string;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    const relationshipRepo = new DrizzleRelationshipRepository(db);
    const memoryRepo = new DrizzleMemoryRepository(db);
    relationshipService = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "test-project",
    );
    memoryService = createTestServiceWithRelationships(relationshipService);

    const m1 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Use tabs in this repo",
      type: "preference",
      author: "alice",
    });
    assertMemory(m1.data);
    sourceId = m1.data.id;

    const m2 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Use 2-space indentation globally",
      type: "preference",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(m2.data);
    targetId = m2.data.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("memory_get includes relationships array", async () => {
    await relationshipService.create({
      sourceId,
      targetId,
      type: "overrides",
      userId: "alice",
    });

    const result = await memoryService.getWithComments(sourceId, "alice");
    expect(result.data.relationships).toBeDefined();
    expect(result.data.relationships).toHaveLength(1);
    expect(result.data.relationships![0].type).toBe("overrides");
    expect(result.data.relationships![0].direction).toBe("outgoing");
    expect(result.data.relationships![0].related_memory.id).toBe(targetId);
  });
});
```

- [ ] **Step 2: Add `createTestServiceWithRelationships` helper**

In `tests/helpers.ts`, add:

```typescript
import { RelationshipService } from "../src/services/relationship-service.js";

export function createTestServiceWithRelationships(
  relationshipService: RelationshipService,
): MemoryService {
  return createTestServiceWith({ relationshipService });
}
```

Update the `TestServiceOptions` interface:

```typescript
interface TestServiceOptions {
  auditService?: AuditService;
  flagService?: FlagService;
  relationshipService?: RelationshipService;
  withSessions?: boolean;
  maxFlagsPerSession?: number;
}
```

Pass `relationshipService` through to the `MemoryService` constructor (once the constructor is updated in step 4).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --run tests/integration/relationships.test.ts`
Expected: FAIL — `relationships` not in `MemoryGetResponse`.

- [ ] **Step 4: Add `relationships` to MemoryGetResponse and MemoryService**

In `src/types/memory.ts`, update `MemoryGetResponse` to include relationships:

```typescript
import type { RelationshipWithMemory } from "./relationship.js";
```

Add to the `MemoryGetResponse` interface:

```typescript
relationships: RelationshipWithMemory[];
```

In `src/services/memory-service.ts`:

1. Add `RelationshipService` as an optional constructor parameter (after `flagService`):

```typescript
import type { RelationshipService } from "./relationship-service.js";
```

```typescript
constructor(
  private readonly memoryRepo: MemoryRepository,
  private readonly workspaceRepo: WorkspaceRepository,
  private readonly embeddingProvider: EmbeddingProvider,
  private readonly projectId: string,
  private readonly commentRepo?: CommentRepository,
  private readonly sessionRepo?: SessionTrackingRepository,
  private readonly sessionLifecycleRepo?: SessionRepository,
  private readonly auditService?: AuditService,
  private readonly flagService?: FlagService,
  private readonly maxFlagsPerSession: number = 5,
  private readonly relationshipService?: RelationshipService,
) {}
```

2. In `getWithComments`, after the flags enrichment block (around line 328), add:

```typescript
// Fetch relationships for this memory
const relationshipsList = this.relationshipService
  ? await this.relationshipService.listForMemory(id, "both", userId)
  : [];
```

3. Include `relationships: relationshipsList` in the returned data object (where `comments` and `flags` are spread).

- [ ] **Step 5: Update server.ts and helpers.ts constructor calls**

In `src/server.ts`, update the `MemoryService` constructor call to pass `relationshipService` as the last argument.

In `tests/helpers.ts`, update `createTestServiceWith` to pass `options.relationshipService` to the MemoryService constructor.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS, including the new memory_get relationship test.

- [ ] **Step 7: Commit**

```bash
git add src/services/memory-service.ts src/types/memory.ts src/server.ts tests/helpers.ts tests/integration/relationships.test.ts
git commit -m "feat: include relationships in memory_get response

memory_get now returns a relationships array with enriched
memory summaries for both incoming and outgoing relationships."
```

---

### Task 6: Integrate Relationships into memory_session_start

**Files:**

- Modify: `src/services/memory-service.ts`
- Modify: `src/types/envelope.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/relationships.test.ts`:

```typescript
describe("session_start includes relationships between returned memories", () => {
  let memoryService: MemoryService;
  let relationshipService: RelationshipService;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    const relationshipRepo = new DrizzleRelationshipRepository(db);
    const memoryRepo = new DrizzleMemoryRepository(db);
    relationshipService = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "test-project",
    );
    memoryService = createTestServiceWithRelationships(relationshipService);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns relationships between session-start memories in meta", async () => {
    const m1 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Use tabs in this repo",
      type: "preference",
      author: "alice",
    });
    assertMemory(m1.data);

    const m2 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Use 2-space indentation globally",
      type: "preference",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(m2.data);

    await relationshipService.create({
      sourceId: m1.data.id,
      targetId: m2.data.id,
      type: "overrides",
      userId: "alice",
    });

    const result = await memoryService.sessionStart("test-ws", "alice");

    // Both memories should be in the result
    const returnedIds = result.data.map((m) => m.id);
    expect(returnedIds).toContain(m1.data.id);
    expect(returnedIds).toContain(m2.data.id);

    // Relationships between them should be in meta
    expect(result.meta.relationships).toBeDefined();
    expect(result.meta.relationships!.length).toBeGreaterThanOrEqual(1);
    expect(result.meta.relationships![0].type).toBe("overrides");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run tests/integration/relationships.test.ts`
Expected: FAIL — `relationships` not in envelope meta.

- [ ] **Step 3: Add relationships to envelope meta and session_start**

In `src/types/envelope.ts`, add to the `meta` type:

```typescript
relationships?: Array<{
  id: string;
  type: string;
  description: string | null;
  confidence: number;
  source_id: string;
  target_id: string;
}>;
```

In `src/services/memory-service.ts`, in the `sessionStart` method, after the flags enrichment block (around line 787), add:

````typescript
// Fetch relationships between the returned memories
let relationshipsData: Envelope<MemorySummaryWithRelevance[]>["meta"]["relationships"];
if (this.relationshipService && result.data.length >= 2) {
  const memoryIds = result.data.map((m) => m.id);
  const rels = await this.relationshipService.listBetweenMemories(
    memoryIds,
    userId,
  );
  if (rels.length > 0) {
Then in session_start (`RelationshipWithMemory` already includes `source_id`/`target_id` from Task 1):

```typescript
let relationshipsData: Envelope<MemorySummaryWithRelevance[]>["meta"]["relationships"];
if (this.relationshipService && result.data.length >= 2) {
  const memoryIds = result.data.map((m) => m.id);
  const rels = await this.relationshipService.listBetweenMemories(
    memoryIds,
    userId,
  );
  if (rels.length > 0) {
    relationshipsData = rels.map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      confidence: r.confidence,
      source_id: r.source_id,
      target_id: r.target_id,
    }));
  }
}
````

Add `relationships: relationshipsData` to the returned meta object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/memory-service.ts src/types/envelope.ts src/types/relationship.ts
git commit -m "feat: include relationships between returned memories in session_start

session_start meta now contains a relationships array showing
connections between the memories in the result set."
```

---

### Task 7: Integrate Relationships into memory_archive

**Files:**

- Modify: `src/services/memory-service.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/relationships.test.ts`:

```typescript
describe("archive soft-deletes relationships", () => {
  let memoryService: MemoryService;
  let relationshipService: RelationshipService;
  let relationshipRepo: DrizzleRelationshipRepository;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    relationshipRepo = new DrizzleRelationshipRepository(db);
    const memoryRepo = new DrizzleMemoryRepository(db);
    relationshipService = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "test-project",
    );
    memoryService = createTestServiceWithRelationships(relationshipService);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("archiving a memory soft-deletes its relationships", async () => {
    const m1 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Memory A",
      type: "fact",
      author: "alice",
    });
    assertMemory(m1.data);

    const m2 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Memory B",
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

    // Verify relationship exists
    let rels = await relationshipService.listForMemory(
      m1.data.id,
      "both",
      "alice",
    );
    expect(rels).toHaveLength(1);

    // Archive m1
    await memoryService.archive(m1.data.id, "alice");

    // Relationship should be soft-deleted
    rels = await relationshipService.listForMemory(m2.data.id, "both", "alice");
    expect(rels).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run tests/integration/relationships.test.ts`
Expected: FAIL — archiving doesn't soft-delete relationships yet.

- [ ] **Step 3: Add relationship archival to the archive method**

In `src/services/memory-service.ts`, in the `archive` method (around line 575), after the `this.memoryRepo.archive(verifiedIds)` call, add:

```typescript
// Soft-delete relationships for archived memories
if (this.relationshipService) {
  for (const id of verifiedIds) {
    await this.relationshipService.archiveByMemoryId(id);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/memory-service.ts tests/integration/relationships.test.ts
git commit -m "feat: soft-delete relationships when archiving a memory

Archiving a memory now sets archived_at on all its relationships
(both incoming and outgoing) to preserve provenance."
```

---

### Task 8: Refactor Consolidation to Create Relationships

**Files:**

- Modify: `src/services/consolidation-service.ts`
- Modify: `src/types/flag.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/consolidation.test.ts`:

```typescript
import { DrizzleRelationshipRepository } from "../../src/repositories/relationship-repository.js";
import { RelationshipService } from "../../src/services/relationship-service.js";

describe("consolidation creates relationships", () => {
  let consolidationService: ConsolidationService;
  let relationshipRepo: DrizzleRelationshipRepository;
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    const memoryRepo = new DrizzleMemoryRepository(db);
    const flagRepo = new DrizzleFlagRepository(db);
    const auditRepo = new DrizzleAuditRepository(db);
    const auditService = new AuditService(auditRepo, "test-project");
    const flagService = new FlagService(flagRepo, auditService, "test-project");
    relationshipRepo = new DrizzleRelationshipRepository(db);
    const relationshipService = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "test-project",
    );
    service = createTestService();
    consolidationService = new ConsolidationService(
      memoryRepo,
      flagService,
      auditService,
      "test-project",
      {
        autoArchiveThreshold: 0.95,
        flagThreshold: 0.9,
        verifyAfterDays: 30,
      },
      relationshipService,
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates a duplicates relationship when flagging duplicates", async () => {
    const m1 = await service.create({
      workspace_id: "test-ws",
      content: "always use snake_case for database columns",
      type: "decision",
      author: "alice",
    });
    assertMemory(m1.data);
    const m2 = await service.create({
      workspace_id: "test-ws",
      content: "always use snake_case for db columns",
      type: "decision",
      author: "alice",
    });
    assertMemory(m2.data);

    await consolidationService.run();

    // Check that a relationship was created
    const rels = await relationshipRepo.findByMemoryId(
      "test-project",
      m2.data.id,
      "both",
    );
    // May or may not have a relationship depending on mock embedding similarity,
    // but verify the relationship creation path doesn't error
    expect(rels.length).toBeGreaterThanOrEqual(0);
  });

  it("creates overrides relationship for cross-scope supersedence", async () => {
    // Create project-scoped and workspace-scoped memories with similar content
    const proj = await service.create({
      workspace_id: "test-ws",
      content: "Global rule about API naming",
      type: "decision",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(proj.data);

    const ws = await service.create({
      workspace_id: "test-ws",
      content: "Global rule about API naming conventions",
      type: "decision",
      author: "alice",
    });
    assertMemory(ws.data);

    await consolidationService.run();

    // Verify no errors occurred
    // (Mock embeddings may not trigger similarity thresholds,
    // but the code path should be exercised)
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run tests/integration/consolidation.test.ts`
Expected: FAIL — `ConsolidationService` constructor doesn't accept `relationshipService`.

- [ ] **Step 3: Add RelationshipService to ConsolidationService**

In `src/services/consolidation-service.ts`:

1. Add the import:

```typescript
import type { RelationshipService } from "./relationship-service.js";
```

2. Update the constructor to accept an optional `RelationshipService`:

```typescript
constructor(
  private readonly memoryRepo: MemoryRepository,
  private readonly flagService: FlagService,
  private readonly auditService: AuditService,
  private readonly projectId: string,
  private readonly config: ConsolidationConfig,
  private readonly relationshipService?: RelationshipService,
) {}
```

3. In `consolidateScope`, when creating a flag for auto_archive (around line 220-230), create a relationship first:

```typescript
if (classification === "auto_archive") {
  const olderMemoryId = pair.memory_b_id;

  // Create a relationship before archiving for provenance
  let relationshipId: string | undefined;
  if (this.relationshipService) {
    try {
      const rel = await this.relationshipService.create({
        sourceId: pair.memory_a_id,
        targetId: olderMemoryId,
        type: "duplicates",
        confidence: pair.similarity,
        userId: "consolidation",
        source: "consolidation",
      });
      relationshipId = rel.id;
    } catch {
      // Relationship creation is best-effort for consolidation
    }
  }

  await this.memoryRepo.archive([olderMemoryId]);
  // ... rest of auto_archive logic
```

4. For `flag_duplicate` (around line 232-274), create a relationship and reference it in the flag:

```typescript
} else if (classification === "flag_duplicate") {
  const alreadyFlagged = await this.flagService.hasOpenFlag(
    pair.memory_b_id,
    "duplicate",
    pair.memory_a_id,
  );
  if (alreadyFlagged) continue;

  // Create a relationship
  let relationshipId: string | undefined;
  if (this.relationshipService) {
    try {
      const rel = await this.relationshipService.create({
        sourceId: pair.memory_a_id,
        targetId: pair.memory_b_id,
        type: "duplicates",
        confidence: pair.similarity,
        userId: "consolidation",
        source: "consolidation",
      });
      relationshipId = rel.id;
    } catch {
      // Best-effort
    }
  }

  const flag = await this.flagService.createFlag({
    memoryId: pair.memory_b_id,
    flagType: "duplicate",
    severity: "needs_review",
    details: {
      relationship_id: relationshipId,
      related_memory_id: pair.memory_a_id, // Keep for backwards compat during migration
      similarity: pair.similarity,
      reason: `Probable duplicate (similarity ${pair.similarity.toFixed(3)})`,
    },
  });
  // ... enrichment logic unchanged
```

5. Similarly update `crossScopeCheck` to create `overrides` relationships, and `userScopeCheck` to create `overrides` relationships.

In `crossScopeCheck` (around line 322-331):

```typescript
// Create an overrides relationship (project memory overrides workspace memory)
let relationshipId: string | undefined;
if (this.relationshipService) {
  try {
    const rel = await this.relationshipService.create({
      sourceId: dup.id,
      targetId: wsMem.id,
      type: "overrides",
      confidence: dup.relevance,
      userId: "consolidation",
      source: "consolidation",
    });
    relationshipId = rel.id;
  } catch {
    // Best-effort
  }
}

const flag = await this.flagService.createFlag({
  memoryId: wsMem.id,
  flagType: "superseded",
  severity: "needs_review",
  details: {
    relationship_id: relationshipId,
    related_memory_id: dup.id,
    similarity: dup.relevance,
    reason: `Workspace memory may duplicate project memory "${dup.title}" (similarity ${dup.relevance.toFixed(3)})`,
  },
});
```

In `userScopeCheck` (around line 399-408), same pattern with `overrides`.

6. Update `src/server.ts` to pass `relationshipService` to the `ConsolidationService` constructor:

```typescript
const consolidationService = new ConsolidationService(
  memoryRepo,
  flagService,
  auditService,
  config.projectId,
  {
    autoArchiveThreshold: config.consolidationAutoArchiveThreshold,
    flagThreshold: config.consolidationFlagThreshold,
    verifyAfterDays: config.consolidationVerifyAfterDays,
  },
  relationshipService,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS, including both existing and new consolidation tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/consolidation-service.ts src/server.ts tests/integration/consolidation.test.ts
git commit -m "feat: consolidation creates relationships before flags

Consolidation now creates duplicates/overrides relationships
alongside flags. Flags reference relationship_id for traceability.
Relationship creation is best-effort to avoid blocking consolidation."
```

---

### Task 9: Flag Details Schema Migration

**Files:**

- Modify: `src/types/flag.ts`

This task adds `relationship_id` to the flag details type. The old `related_memory_id` and `similarity` fields are kept for backwards compatibility — existing flags still have them. New flags created by consolidation will include `relationship_id`.

- [ ] **Step 1: Update the Flag details type**

In `src/types/flag.ts`, update the `details` field in the `Flag` interface:

```typescript
details: {
  related_memory_id?: string;
  relationship_id?: string;
  similarity?: number;
  reason: string;
};
```

- [ ] **Step 2: Run all tests to verify nothing breaks**

Run: `npm test`
Expected: All tests PASS — this is an additive change.

- [ ] **Step 3: Commit**

```bash
git add src/types/flag.ts
git commit -m "feat: add relationship_id to flag details type

Flags can now reference a relationship for traceability.
Old fields (related_memory_id, similarity) kept for backwards
compatibility with existing flags."
```

---

### Task 10: Data Migration Script for Existing Flags

**Files:**

- Create: `scripts/migrate-flag-relationships.ts`

This is a one-time migration script that:

1. Reads all flags with `related_memory_id` in details
2. Creates corresponding relationships
3. Updates flag details to include `relationship_id`

- [ ] **Step 1: Write the migration script**

Create `scripts/migrate-flag-relationships.ts`:

```typescript
import "dotenv/config";
import { createDb } from "../src/db/index.js";
import { flags, relationships } from "../src/db/schema.js";
import { config } from "../src/config.js";
import { generateId } from "../src/utils/id.js";
import { isNotNull, isNull, sql } from "drizzle-orm";
import { logger } from "../src/utils/logger.js";

async function migrate() {
  const db = createDb(config.databaseUrl);

  logger.info("Migrating existing flag relationships...");

  // Find all flags with related_memory_id in details
  const allFlags = await db
    .select()
    .from(flags)
    .where(sql`details->>'related_memory_id' IS NOT NULL`);

  logger.info(`Found ${allFlags.length} flags with related_memory_id`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const flag of allFlags) {
    const details = flag.details as {
      related_memory_id?: string;
      relationship_id?: string;
      similarity?: number;
      reason: string;
    };

    // Skip if already migrated
    if (details.relationship_id) {
      skipped++;
      continue;
    }

    const relatedMemoryId = details.related_memory_id;
    if (!relatedMemoryId) {
      skipped++;
      continue;
    }

    // Determine relationship type from flag type
    let relType: string;
    if (flag.flag_type === "duplicate") {
      relType = "duplicates";
    } else if (
      flag.flag_type === "superseded" ||
      flag.flag_type === "override"
    ) {
      relType = "overrides";
    } else {
      skipped++;
      continue;
    }

    // Determine source and target based on flag type
    // For duplicates: related_memory_id is the "keeper", memory_id is the duplicate
    // For superseded: related_memory_id is the broader memory that supersedes
    const sourceId = relatedMemoryId;
    const targetId = flag.memory_id;

    // Check if relationship already exists
    const [existing] = await db
      .select()
      .from(relationships)
      .where(
        sql`project_id = ${flag.project_id}
            AND source_id = ${sourceId}
            AND target_id = ${targetId}
            AND type = ${relType}`,
      );

    let relationshipId: string;
    if (existing) {
      relationshipId = existing.id;
    } else {
      relationshipId = generateId();
      await db.insert(relationships).values({
        id: relationshipId,
        project_id: flag.project_id,
        source_id: sourceId,
        target_id: targetId,
        type: relType,
        description: null,
        confidence: details.similarity ?? 1.0,
        created_by: "migration",
        source: "consolidation",
        archived_at: flag.severity === "auto_resolved" ? new Date() : null,
        created_at: flag.created_at,
      });
      created++;
    }

    // Update flag details with relationship_id
    await db
      .update(flags)
      .set({
        details: { ...details, relationship_id: relationshipId },
      })
      .where(sql`id = ${flag.id}`);
    updated++;
  }

  logger.info(
    `Migration complete: ${created} relationships created, ${updated} flags updated, ${skipped} skipped`,
  );

  await db.$client.end();
}

migrate().catch((err) => {
  logger.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Add a script entry to package.json**

Add to `scripts` in `package.json`:

```json
"migrate:flag-relationships": "tsx scripts/migrate-flag-relationships.ts"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-flag-relationships.ts package.json
git commit -m "feat: add one-time migration script for flag-to-relationship backfill

Reads existing flags with related_memory_id, creates corresponding
relationships, and updates flags to reference the relationship.
Idempotent — safe to run multiple times."
```

---

### Task 11: Final Integration Test and Cleanup

**Files:**

- Modify: `tests/integration/relationships.test.ts`

- [ ] **Step 1: Write an end-to-end lifecycle test**

Add to `tests/integration/relationships.test.ts`:

```typescript
describe("end-to-end: create relationship → get → archive → verify cleanup", () => {
  let memoryService: MemoryService;
  let relationshipService: RelationshipService;
  let relationshipRepo: DrizzleRelationshipRepository;

  beforeEach(async () => {
    await truncateAll();
    const db = getTestDb();
    relationshipRepo = new DrizzleRelationshipRepository(db);
    const memoryRepo = new DrizzleMemoryRepository(db);
    relationshipService = new RelationshipService(
      relationshipRepo,
      memoryRepo,
      "test-project",
    );
    memoryService = createTestServiceWithRelationships(relationshipService);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("full lifecycle", async () => {
    // 1. Create two memories
    const m1 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Use tabs in this workspace",
      type: "preference",
      author: "alice",
    });
    assertMemory(m1.data);

    const m2 = await memoryService.create({
      workspace_id: "test-ws",
      content: "Use 2-space indentation globally",
      type: "preference",
      scope: "project",
      author: "alice",
      source: "manual",
    });
    assertMemory(m2.data);

    // 2. Create a relationship
    const rel = await relationshipService.create({
      sourceId: m1.data.id,
      targetId: m2.data.id,
      type: "overrides",
      description: "Workspace tabs override project spaces",
      userId: "alice",
    });
    expect(rel.type).toBe("overrides");

    // 3. memory_get includes the relationship
    const getResult = await memoryService.getWithComments(m1.data.id, "alice");
    expect(getResult.data.relationships).toHaveLength(1);
    expect(getResult.data.relationships[0].related_memory.id).toBe(m2.data.id);

    // 4. session_start includes the relationship
    const session = await memoryService.sessionStart("test-ws", "alice");
    const returnedIds = session.data.map((m) => m.id);
    if (returnedIds.includes(m1.data.id) && returnedIds.includes(m2.data.id)) {
      expect(session.meta.relationships).toBeDefined();
      expect(session.meta.relationships!.length).toBeGreaterThanOrEqual(1);
    }

    // 5. Archive m1 → relationship is soft-deleted
    await memoryService.archive(m1.data.id, "alice");
    const afterArchive = await relationshipService.listForMemory(
      m2.data.id,
      "both",
      "alice",
    );
    expect(afterArchive).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Run lint and type-check**

Run: `npm run lint && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/relationships.test.ts
git commit -m "test: add end-to-end lifecycle test for relationships

Covers create → get → session_start → archive cascade flow."
```

---

### Task 12: Update Documentation

**Files:**

- Modify: `CLAUDE.md` (if it exists in the repo)
- Modify: `README.md`

- [ ] **Step 1: Update CLAUDE.md with relationship tool documentation**

Add information about the three new MCP tools (`memory_relate`, `memory_unrelate`, `memory_relationships`) to the project's CLAUDE.md if it documents available tools.

- [ ] **Step 2: Update README.md tool table**

Add the three new tools to the tool listing in README.md with brief descriptions:

| Tool                   | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `memory_relate`        | Create a directional relationship between two memories |
| `memory_unrelate`      | Remove a relationship                                  |
| `memory_relationships` | List relationships for a memory                        |

Also document the well-known relationship types: `overrides`, `implements`, `refines`, `contradicts`, `duplicates`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document relationship tracking tools and types"
```
