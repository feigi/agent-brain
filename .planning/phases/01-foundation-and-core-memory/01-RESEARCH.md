# Phase 1: Foundation and Core Memory - Research

**Researched:** 2026-03-23
**Domain:** MCP server with PostgreSQL/pgvector storage, embedding generation, and semantic memory search
**Confidence:** HIGH

## Summary

Phase 1 is a greenfield implementation of an MCP server that provides CRUD and semantic search over agent memories. The technology stack is fully locked in CLAUDE.md and CONTEXT.md -- no stack decisions remain open. The core challenge is wiring together well-documented, stable libraries: MCP SDK for the tool interface, Drizzle ORM with pgvector for storage and vector search, and AWS Bedrock Titan V2 for embeddings.

All libraries are at stable, current versions. The MCP SDK (1.27.1) uses `McpServer` + `registerTool()` with Zod schemas. Drizzle ORM (0.45.1) has first-class `vector()` column type, `cosineDistance()`, and HNSW index definitions. The pgvector npm package (0.2.1) provides `toSql()` for vector serialization. These integrate cleanly -- no compatibility issues found.

**Primary recommendation:** Structure as a layered architecture (transport -> tools -> services -> repositories -> database) with clean interfaces at the embedding and storage boundaries. Start with the database schema and Docker Compose, then build upward through the service layer to MCP tool registration.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** CRUD-style naming with `memory_` namespace prefix. Full tool inventory: `memory_create`, `memory_get`, `memory_update`, `memory_archive`, `memory_search`, `memory_list`, `memory_verify`, `memory_list_stale` (8 tools total)
- **D-02:** Envelope response structure -- `{ data: {...}, meta: { count, timing } }`. Consistent shape across all tools, room for pagination metadata.
- **D-03:** Title is optional. Auto-generate from content if not provided (first N chars or summarization).
- **D-04:** Semantic search only in Phase 1 -- no tag filtering on `memory_search`. Tag filtering is available on `memory_list` instead.
- **D-05:** Error handling -- Claude's discretion. Follow MCP SDK conventions for error responses.
- **D-06:** `memory_archive` accepts single ID or array of IDs for bulk operations.
- **D-07:** Both `memory_list` (paginated browse) and `memory_search` (semantic) are available.
- **D-08:** Per-call `scope` parameter on each tool -- agent specifies `project` or `user` per call.
- **D-09:** `memory_update` uses partial updates (PATCH-style) -- only send fields to change.
- **D-10:** Comment tool (`comment_memory`) deferred to Phase 3 (Team Collaboration).
- **D-11:** `memory_verify` included in Phase 1 -- marks memory as still-accurate (updates `verified_at`).
- **D-12:** `memory_list_stale` included in Phase 1 -- lists memories not verified within a configurable threshold.
- **D-13:** Tools only -- no MCP resource endpoints in Phase 1.
- **D-14:** `memory_search` accepts optional `limit` parameter with default of 10.
- **D-15:** Tool descriptions include usage examples for agents, not just parameter docs.
- **D-16:** Tags structured as both: a required `type` field (predefined enum) plus optional free-form `tags` array for extra categorization.
- **D-17:** Predefined memory types enforced as PostgreSQL enum: `fact`, `decision`, `learning`, `pattern`, `preference`, `architecture`.
- **D-18:** ID format -- Claude's discretion (nanoid recommended in tech stack).
- **D-19:** Embedding input: concatenate title + content for embedding generation.
- **D-20:** Soft content length limit (~4000 chars). Warn but allow longer. Truncate for embedding, store full raw text.
- **D-21:** Full lifecycle timestamps: `created_at`, `updated_at`, `verified_at`, `archived_at`.
- **D-22:** Per-memory embedding metadata stored alongside vector (model name, dimensions). Enables gradual re-embedding on provider change.
- **D-23:** Optional `source` field to track origin: `manual`, `agent-auto`, `session-review`, or custom string.
- **D-24:** Optional `session_id` field to group memories by agent session.
- **D-25:** `author` field included from Phase 1 -- records who created each memory.
- **D-26:** Optional `metadata` JSONB field for extensible key-value data (file paths, URLs, etc.).
- **D-27:** Auto re-embed on content or title update. Titan is cheap ($0.02/1M tokens).
- **D-28:** Drop embedding vector on archive to save storage. Re-embedding required if un-archive is added later.
- **D-29:** No memory-to-memory linking in Phase 1. Related memories discovered via semantic search.
- **D-30:** Optimistic locking via `version` column. Update fails if version changed since read.
- **D-31:** `project_id` is a per-call parameter -- agent passes it with each tool call. Single server handles multiple projects.
- **D-32:** Projects identified by human-readable slug string (e.g., `agentic-brain`). Must be unique.
- **D-33:** No default project -- every call must explicitly specify `project_id`. No ambiguity.
- **D-34:** Auto-create projects on first mention -- first `memory_create` with a new slug creates the project record.
- **D-35:** Database connection via `DATABASE_URL` environment variable.
- **D-36:** AWS credentials via default credential chain (env vars, IAM role, SSO).
- **D-37:** App-level filtering for project scoping in Phase 1 (WHERE clauses). RLS deferred.
- **D-38:** `user_id` required on all write operations (memory_create, memory_update, memory_archive). Ensures provenance from day one.
- **D-39:** `.env` file support via dotenv for local development.
- **D-40:** No health/status tool -- if tools work, server is healthy.
- **D-41:** Default 10 results for `memory_search`.
- **D-42:** Configurable per-call minimum similarity threshold (default ~0.3). Results below threshold excluded.
- **D-43:** Search results return full memory object plus similarity score.
- **D-44:** Results only -- no debug/embedding info exposed.
- **D-45:** `memory_list` supports `sort_by` (created_at, updated_at) and `order` (asc, desc). Default: created_at desc.
- **D-46:** Cursor-based pagination for `memory_list`.
- **D-47:** Search scoped to one project per call. Cross-project search deferred to Phase 2 (SCOP-03).
- **D-48:** `memory_list` supports filtering by `type` and `tags`.
- **D-49:** Stdio transport only for Phase 1. HTTP transport deferred.
- **D-50:** Entry point: `npx tsx src/server.ts`. No build step required.
- **D-51:** Graceful shutdown -- handle SIGTERM/SIGINT, finish pending DB writes before exit.
- **D-52:** Startup banner logged to stderr: version, DB connection status, embedding provider.
- **D-53:** Auto-migrate on startup -- run pending Drizzle migrations on first connect.
- **D-54:** Fail the save when embedding provider is unavailable. Return error to agent. No partial state.
- **D-55:** Mock embedding provider for development -- deterministic (hash-based) vectors. Enables local dev without AWS credentials.
- **D-56:** Synchronous embedding -- `memory_create` blocks until embedding is generated. Memory immediately searchable.
- **D-57:** Configurable embedding API timeout (~10 seconds default via env var).
- **D-58:** Docker Compose with `pgvector/pgvector:pg17` for local Postgres.
- **D-59:** Seed script with sample memories for development.
- **D-60:** `npm run dev` -- starts Docker, runs migrations, launches server with `tsx watch`.
- **D-61:** Tests run against real Docker Postgres with pgvector. No mocks for storage layer.
- **D-62:** MCP Inspector as devDependency with `npm run inspect` script.
- **D-63:** `.env.example` file documenting all expected environment variables.
- **D-64:** Truncate tables between test suites for clean state.
- **D-65:** Fully concurrent saves -- each memory_create is an independent transaction.
- **D-66:** No rate limiting in Phase 1 (stdio = local access only).
- **D-67:** Archive is idempotent -- archiving an already-archived memory returns success.
- **D-68:** No un-archive/restore tool in Phase 1 -- archive is one-way.

### Claude's Discretion

- Error handling approach (D-05) -- follow MCP SDK conventions
- ID format (D-18) -- nanoid recommended in tech stack
- User identity mechanism (D-38 establishes user_id is required on writes; Claude decides whether per-call param or env var is the transport mechanism, consistent with project_id being per-call)
- Test DB reset strategy details (D-64)

### Deferred Ideas (OUT OF SCOPE)

- Comment/threading -> Phase 3
- Cross-project search -> Phase 2
- Tag filtering on search -> Phase 2 (ADVR-02)
- HTTP transport -> Future phase
- RLS enforcement -> Phase 3
- Un-archive/restore -> Not planned (archive is one-way)
  </user_constraints>

<phase_requirements>

## Phase Requirements

| ID      | Description                                                           | Research Support                                                                                       |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| INFR-01 | MCP server exposes all memory operations as tools via stdio transport | MCP SDK `McpServer` + `registerTool()` + `StdioServerTransport` -- fully documented pattern            |
| INFR-02 | Storage layer abstracted behind an interface                          | Repository pattern with interface; Drizzle ORM implementation behind it                                |
| INFR-03 | Embedding provider abstracted behind an interface                     | `EmbeddingProvider` interface with Titan and Mock implementations                                      |
| INFR-04 | Database schema supports pgvector with HNSW indexing                  | Drizzle `vector({ dimensions: 512 })` + `.using('hnsw', col.op('vector_cosine_ops'))`                  |
| INFR-05 | Database migrations managed programmatically                          | Drizzle Kit 0.31.x `generate` + `migrate` commands, auto-run on startup                                |
| CORE-01 | Save a memory with content, optional title, and optional tags         | `memory_create` tool with Zod input schema, embedding generation, DB insert                            |
| CORE-02 | Retrieve a specific memory by ID                                      | `memory_get` tool, simple SELECT by nanoid primary key                                                 |
| CORE-03 | Update existing memory content, title, or tags                        | `memory_update` tool, PATCH-style partial update, optimistic locking via version column, auto re-embed |
| CORE-04 | Archive a memory (soft delete)                                        | `memory_archive` tool, sets `archived_at`, drops embedding vector, single or bulk IDs                  |
| CORE-05 | Search by semantic similarity with ranked results                     | `memory_search` tool, cosineDistance query, similarity threshold, limit parameter                      |
| CORE-06 | Tag memories with categories                                          | PostgreSQL enum for `type` field + text array for free-form `tags`                                     |
| CORE-07 | Memories persist across sessions in Postgres                          | pgvector/pgvector:pg17 Docker image, Drizzle migrations, connection pooling                            |
| CORE-08 | Raw text stored alongside embeddings                                  | `content` text column stored independently of `embedding` vector column                                |
| CORE-09 | Embedding model metadata stored with each memory                      | `embedding_model` and `embedding_dimensions` columns per row                                           |
| SCOP-01 | Memories scoped to a project                                          | `project_id` FK on memories table, WHERE clause filtering                                              |
| SCOP-02 | User-level memories follow user across projects                       | `scope` field (`project` or `user`), user-scoped memories bypass project filter                        |
| SCOP-04 | Cross-project memory leakage prevented at DB level                    | App-level WHERE clauses in Phase 1 (RLS deferred to Phase 3 per D-37)                                  |

</phase_requirements>

## Standard Stack

### Core

| Library                   | Version (Verified)     | Purpose                  | Why Standard                                                               |
| ------------------------- | ---------------------- | ------------------------ | -------------------------------------------------------------------------- |
| TypeScript                | 5.9.3                  | Language                 | Current stable. Verified via `npm view`.                                   |
| Node.js                   | 22.x LTS (recommended) | Runtime                  | LTS through Apr 2027. Dev machine runs 25.8.1 which is forward-compatible. |
| @modelcontextprotocol/sdk | 1.27.1                 | MCP server framework     | Latest stable. `McpServer` + `registerTool()` + `StdioServerTransport`.    |
| PostgreSQL                | 17.x                   | Database                 | pgvector 0.8.x support on RDS. Local via Docker.                           |
| pgvector (extension)      | 0.8.x                  | Vector similarity search | HNSW indexes, iterative scan, cosine distance.                             |
| Drizzle ORM               | 0.45.1                 | ORM / query builder      | Built-in `vector()`, `cosineDistance()`, HNSW index defs.                  |
| zod                       | 4.3.6                  | Schema validation        | MCP SDK peer dep. Tool input schemas.                                      |

### Supporting

| Library                         | Version (Verified) | Purpose                      | When to Use                                               |
| ------------------------------- | ------------------ | ---------------------------- | --------------------------------------------------------- |
| @aws-sdk/client-bedrock-runtime | 3.1014.0           | Bedrock API client           | Titan V2 embedding calls                                  |
| pgvector (npm)                  | 0.2.1              | Vector serialization helpers | `toSql()` for Drizzle, import from `pgvector/drizzle-orm` |
| postgres (postgres.js)          | 3.4.8              | PostgreSQL driver            | Drizzle's recommended Postgres driver                     |
| tsx                             | 4.21.0             | TypeScript execution         | Dev server entry, `tsx watch`, scripts                    |
| dotenv                          | 17.3.1             | Environment config           | Load `.env` in local dev                                  |
| nanoid                          | 5.1.7              | ID generation                | ESM-only. `nanoid(21)` for 21-char IDs.                   |

### Development

| Tool                            | Version (Verified) | Purpose                          |
| ------------------------------- | ------------------ | -------------------------------- |
| drizzle-kit                     | 0.31.10            | Migration generation and running |
| vitest                          | 4.1.0              | Testing framework                |
| @modelcontextprotocol/inspector | 0.21.1             | MCP server debugging UI          |
| docker-compose                  | 2.39.2             | Local pgvector/Postgres          |

### Alternatives Considered

| Instead of  | Could Use             | Tradeoff                                                                                                               |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Drizzle ORM | Raw SQL (postgres.js) | Escape hatch for complex vector queries. Start with Drizzle, drop to `sql` template literals when ORM gets in the way. |
| postgres.js | node-postgres (pg)    | Only if native C bindings needed. postgres.js is faster for typical workloads.                                         |
| nanoid      | UUID v7               | UUID v7 has time-ordering built in but is 36 chars. nanoid is 21 chars, URL-safe.                                      |

**Installation:**

```bash
# Core runtime
npm install @modelcontextprotocol/sdk zod postgres drizzle-orm pgvector @aws-sdk/client-bedrock-runtime nanoid dotenv tsx

# Dev dependencies
npm install -D drizzle-kit vitest @modelcontextprotocol/inspector typescript @types/node
```

## Architecture Patterns

### Recommended Project Structure

```
src/
  server.ts              # Entry point -- McpServer + StdioServerTransport
  config.ts              # Environment config (DATABASE_URL, AWS region, etc.)
  tools/                 # MCP tool registration (one file per tool or grouped)
    memory-create.ts
    memory-get.ts
    memory-update.ts
    memory-archive.ts
    memory-search.ts
    memory-list.ts
    memory-verify.ts
    memory-list-stale.ts
    index.ts             # Registers all tools on McpServer
  services/              # Business logic layer
    memory-service.ts    # Orchestrates operations (embed + store, update + re-embed)
    embedding-service.ts # Calls embedding provider, handles timeout/retry
  providers/             # Abstracted external providers
    embedding/
      types.ts           # EmbeddingProvider interface
      titan.ts           # Amazon Titan V2 implementation
      mock.ts            # Deterministic mock for dev/test
      index.ts           # Factory based on env config
  repositories/          # Database access layer
    types.ts             # MemoryRepository interface (INFR-02)
    memory-repository.ts # Drizzle/pgvector implementation
    project-repository.ts
  db/
    schema.ts            # Drizzle table definitions (memories, projects)
    index.ts             # Drizzle client initialization (postgres.js driver)
    migrate.ts           # Auto-migration runner
  types/                 # Shared TypeScript types
    memory.ts            # Memory, MemoryCreate, MemoryUpdate types
    envelope.ts          # Response envelope type
  utils/
    id.ts                # nanoid wrapper
    logger.ts            # stderr-only logger
    errors.ts            # Domain error types
drizzle/                 # Generated migration SQL files
docker-compose.yml       # pgvector/pgvector:pg17
drizzle.config.ts        # Drizzle Kit configuration
vitest.config.ts         # Vitest configuration
.env.example             # All expected env vars documented
package.json
tsconfig.json
```

### Pattern 1: MCP Tool Registration with Zod Schemas

**What:** Each tool is registered via `server.registerTool()` with a Zod input schema and async handler.
**When to use:** All 8 memory tools.
**Example:**

```typescript
// Source: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "agentic-brain",
  version: "0.1.0",
});

server.registerTool(
  "memory_create",
  {
    description: `Save a new memory. Example: memory_create({ project_id: "my-project", content: "Always run migrations before deploying", type: "decision" })`,
    inputSchema: {
      project_id: z.string().describe("Project slug (e.g., 'my-project')"),
      content: z.string().describe("Memory content text"),
      title: z
        .string()
        .optional()
        .describe("Optional title. Auto-generated if omitted."),
      type: z.enum([
        "fact",
        "decision",
        "learning",
        "pattern",
        "preference",
        "architecture",
      ]),
      tags: z
        .array(z.string())
        .optional()
        .describe("Free-form categorization tags"),
      scope: z.enum(["project", "user"]).default("project"),
      user_id: z.string().describe("Who is creating this memory"),
      source: z
        .string()
        .optional()
        .describe("Origin: manual, agent-auto, session-review"),
      session_id: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
  },
  async (params) => {
    const result = await memoryService.create(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Pattern 2: Envelope Response Structure (D-02)

**What:** All tools return `{ data, meta }` wrapped in MCP content.
**When to use:** Every tool response.
**Example:**

```typescript
// Response envelope per D-02
interface Envelope<T> {
  data: T;
  meta: {
    count?: number;
    timing?: number; // ms
    cursor?: string; // for paginated results
    has_more?: boolean;
  };
}

function toolResponse<T>(envelope: Envelope<T>): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
}
```

### Pattern 3: Embedding Provider Interface (INFR-03)

**What:** Abstract embedding generation behind a swappable interface.
**When to use:** Memory create and update operations.
**Example:**

```typescript
// Source: CLAUDE.md Stack Patterns
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  readonly modelName: string;
  readonly dimensions: number;
}

// Titan V2 implementation
// Source: https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html
class TitanEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "amazon.titan-embed-text-v2:0";
  readonly dimensions = 512;

  async embed(text: string): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: this.modelName,
      body: JSON.stringify({
        inputText: text.slice(0, 32000), // safety margin for ~8192 tokens
        dimensions: this.dimensions,
        normalize: true,
      }),
      contentType: "application/json",
      accept: "application/json",
    });
    const response = await this.client.send(command);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    return body.embedding;
  }
}

// Mock implementation for dev/test (D-55)
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "mock-deterministic";
  readonly dimensions = 512;

  async embed(text: string): Promise<number[]> {
    // Deterministic hash-based vector for reproducible tests
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Array.from(
      { length: 512 },
      (_, i) => Math.sin(hash * (i + 1) * 0.001) * 0.5 + 0.5,
    );
  }
}
```

### Pattern 4: Drizzle Schema with pgvector (INFR-04)

**What:** Define memories table with vector column, HNSW index, and PostgreSQL enum.
**When to use:** Database schema definition.
**Example:**

```typescript
// Source: https://orm.drizzle.team/docs/extensions/pg#pg_vector
import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  vector,
} from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";

export const memoryTypeEnum = pgEnum("memory_type", [
  "fact",
  "decision",
  "learning",
  "pattern",
  "preference",
  "architecture",
]);

export const memoryScopeEnum = pgEnum("memory_scope", ["project", "user"]);

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(), // nanoid
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id),
    content: text("content").notNull(),
    title: text("title").notNull(), // auto-generated if not provided
    type: memoryTypeEnum("type").notNull(),
    scope: memoryScopeEnum("scope").notNull().default("project"),
    tags: text("tags").array().default([]),
    author: text("author").notNull(),
    source: text("source"), // manual, agent-auto, session-review
    session_id: text("session_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    embedding: vector("embedding", { dimensions: 512 }),
    embedding_model: text("embedding_model"),
    embedding_dimensions: integer("embedding_dimensions"),
    version: integer("version").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    verified_at: timestamp("verified_at", { withTimezone: true }),
    archived_at: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("memories_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("memories_project_id_idx").on(table.project_id),
    index("memories_author_idx").on(table.author),
    index("memories_type_idx").on(table.type),
    index("memories_created_at_idx").on(table.created_at),
  ],
);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(), // slug string, e.g. "agentic-brain"
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

### Pattern 5: Cosine Similarity Search

**What:** Vector search with similarity threshold and limit.
**When to use:** `memory_search` tool.
**Example:**

```typescript
// Source: https://orm.drizzle.team/docs/guides/vector-similarity-search
import { cosineDistance, desc, gt, sql, and, eq, isNull } from "drizzle-orm";

async function searchMemories(
  embedding: number[],
  projectId: string,
  scope: "project" | "user",
  userId: string,
  limit: number = 10,
  minSimilarity: number = 0.3,
) {
  const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, embedding)})`;

  return await db
    .select({
      id: memories.id,
      content: memories.content,
      title: memories.title,
      type: memories.type,
      tags: memories.tags,
      author: memories.author,
      created_at: memories.created_at,
      updated_at: memories.updated_at,
      similarity,
    })
    .from(memories)
    .where(
      and(
        scope === "project"
          ? eq(memories.project_id, projectId)
          : eq(memories.author, userId),
        isNull(memories.archived_at),
        gt(similarity, minSimilarity),
      ),
    )
    .orderBy(desc(similarity))
    .limit(limit);
}
```

### Pattern 6: Cursor-Based Pagination (D-46)

**What:** Keyset pagination using created_at + id composite cursor.
**When to use:** `memory_list` tool.
**Example:**

```typescript
// Source: https://orm.drizzle.team/docs/guides/cursor-based-pagination
import { and, or, lt, eq, gt, desc, asc, isNull } from "drizzle-orm";

interface ListCursor {
  created_at: string; // ISO timestamp
  id: string;
}

async function listMemories(
  projectId: string,
  cursor?: ListCursor,
  pageSize: number = 20,
  sortBy: "created_at" | "updated_at" = "created_at",
  order: "asc" | "desc" = "desc",
) {
  const sortCol =
    sortBy === "created_at" ? memories.created_at : memories.updated_at;
  const cmp = order === "desc" ? lt : gt;
  const orderFn = order === "desc" ? desc : asc;

  return await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.project_id, projectId),
        isNull(memories.archived_at),
        cursor
          ? or(
              cmp(sortCol, new Date(cursor.created_at)),
              and(
                eq(sortCol, new Date(cursor.created_at)),
                cmp(memories.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(orderFn(sortCol), orderFn(memories.id))
    .limit(pageSize + 1); // fetch one extra to determine has_more
}
```

### Pattern 7: Optimistic Locking (D-30)

**What:** Version-based conflict detection on updates.
**When to use:** `memory_update` tool.
**Example:**

```typescript
async function updateMemory(
  id: string,
  expectedVersion: number,
  updates: Partial<Memory>,
) {
  const result = await db
    .update(memories)
    .set({
      ...updates,
      version: sql`${memories.version} + 1`,
      updated_at: new Date(),
    })
    .where(and(eq(memories.id, id), eq(memories.version, expectedVersion)))
    .returning();

  if (result.length === 0) {
    throw new ConflictError(
      `Memory ${id} was modified by another process. Refetch and retry.`,
    );
  }
  return result[0];
}
```

### Pattern 8: MCP Error Handling (D-05 -- Claude's Discretion)

**What:** Return `isError: true` for domain errors, throw `McpError` for protocol errors.
**When to use:** All tool handlers.
**Recommendation:** Use `isError: true` in `CallToolResult` for recoverable errors the agent can act on (not found, conflict, validation). Throw `McpError` only for protocol-level failures.
**Example:**

```typescript
// Domain error -- agent can retry or adjust
return {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: "Memory not found",
        code: "NOT_FOUND",
      }),
    },
  ],
  isError: true,
};

// Protocol error -- fundamentally broken request
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
throw new McpError(ErrorCode.InvalidParams, "project_id is required");
```

### Anti-Patterns to Avoid

- **console.log() in stdio server:** Writes to stdout, corrupts JSON-RPC framing, breaks the server. Use `console.error()` for all logging.
- **Building embedding in the tool handler:** Keep tool handlers thin. Delegate to service layer.
- **Storing embedding without metadata:** Always store `embedding_model` and `embedding_dimensions` alongside the vector (D-22). Enables provider migration.
- **Using OFFSET pagination:** Breaks with concurrent inserts/deletes. Use cursor-based (D-46).
- **Mocking the database in tests:** User decision D-61 requires tests run against real Docker Postgres.
- **Using drizzle-orm 1.0 beta or drizzle-kit 1.0 beta:** Breaking migration changes. Stick with 0.45.x / 0.31.x.

## Don't Hand-Roll

| Problem                  | Don't Build            | Use Instead                                                         | Why                                                                               |
| ------------------------ | ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Vector similarity search | Custom distance math   | `cosineDistance()` from Drizzle + pgvector HNSW index               | HNSW is orders of magnitude faster than brute force; pgvector handles it natively |
| Embedding generation     | HTTP client to Bedrock | `@aws-sdk/client-bedrock-runtime` `InvokeModelCommand`              | Handles auth, retries, credential chain, region routing                           |
| ID generation            | Random string builder  | `nanoid(21)`                                                        | Cryptographically secure, URL-safe, collision-resistant                           |
| Schema migrations        | Manual SQL scripts     | `drizzle-kit generate` + `drizzle-kit migrate`                      | Tracks schema drift, generates reversible SQL, handles ordering                   |
| JSON-RPC framing         | Custom stdio parser    | `StdioServerTransport` from MCP SDK                                 | Handles framing, buffering, error serialization                                   |
| Vector serialization     | Manual array-to-SQL    | `pgvector` npm package `toSql()`                                    | Handles the `[1,2,3]` format pgvector expects                                     |
| Cursor pagination        | Custom SQL builder     | Drizzle's `gt()`, `lt()`, `and()`, `or()` composable query builders | Type-safe, composable, handles the composite cursor pattern cleanly               |

**Key insight:** Every operation in this phase has a library-level solution. The engineering challenge is wiring them together cleanly, not building primitives.

## Common Pitfalls

### Pitfall 1: console.log Breaks Stdio MCP Servers

**What goes wrong:** Any `console.log()` output goes to stdout, which is the JSON-RPC transport channel. A single log statement corrupts the message stream and the MCP client silently disconnects.
**Why it happens:** Natural habit from Node.js development.
**How to avoid:** Create a `logger.ts` that wraps `console.error()`. Lint rule to ban `console.log`. All debug output to stderr.
**Warning signs:** MCP client reports "server disconnected" or tools silently fail.

### Pitfall 2: pgvector Extension Not Enabled

**What goes wrong:** `CREATE TABLE` with `vector` column fails because pgvector extension is not installed.
**Why it happens:** Extension must be explicitly created in each database.
**How to avoid:** First migration includes `CREATE EXTENSION IF NOT EXISTS vector;`. Docker image `pgvector/pgvector:pg17` has the extension available but not auto-enabled per database.
**Warning signs:** `ERROR: type "vector" does not exist`.

### Pitfall 3: Drizzle pgEnum Must Be Exported

**What goes wrong:** Drizzle Kit generates migration without the `CREATE TYPE ... AS ENUM` statement.
**Why it happens:** If the `pgEnum` definition is not exported from the schema file referenced in `drizzle.config.ts`, Drizzle Kit does not see it.
**How to avoid:** Always export enum definitions from the schema entry point. Verify generated migration SQL includes `CREATE TYPE`.
**Warning signs:** Migration runs but columns have wrong type or `INSERT` fails with type mismatch.

### Pitfall 4: nanoid v5 Is ESM-Only

**What goes wrong:** `require('nanoid')` fails. `import { nanoid } from 'nanoid'` works.
**Why it happens:** nanoid v5 dropped CommonJS support.
**How to avoid:** Ensure `tsconfig.json` uses `"module": "nodenext"` and `"moduleResolution": "nodenext"`. The project is ESM-first via tsx anyway.
**Warning signs:** `ERR_REQUIRE_ESM` or `Cannot find module` errors.

### Pitfall 5: Embedding Dimension Mismatch

**What goes wrong:** Inserting a 1024-dimension vector into a column defined as `vector(512)` throws a Postgres error.
**Why it happens:** Embedding provider returns wrong dimensions, or mock provider has different dimension count.
**How to avoid:** `EmbeddingProvider` interface declares `dimensions` property. Validate at startup that provider dimensions match schema. All providers must return 512.
**Warning signs:** `ERROR: expected 512 dimensions, not 1024`.

### Pitfall 6: HNSW Index Not Used for Filtered Queries

**What goes wrong:** Similarity search with WHERE clauses falls back to sequential scan, ignoring the HNSW index.
**Why it happens:** Before pgvector 0.8.0, filtered queries could not use HNSW efficiently.
**How to avoid:** pgvector 0.8.0+ has iterative index scans that handle this. Ensure Docker image has pgvector 0.8.x. Verify via `EXPLAIN ANALYZE` during development.
**Warning signs:** Search queries are slow despite HNSW index existing.

### Pitfall 7: Optimistic Locking Race Window

**What goes wrong:** Two concurrent updates read the same version, both try to write, one silently succeeds and the other fails.
**Why it happens:** The version check is in the WHERE clause -- if no rows match, Drizzle returns an empty array instead of throwing.
**How to avoid:** Check `result.length === 0` and throw a `ConflictError`. The tool handler returns `isError: true` with a retry hint.
**Warning signs:** Updates silently dropping with no error to the agent.

### Pitfall 8: postgres.js Connection Pooling on Shutdown

**What goes wrong:** Process exits before pending queries complete, causing data corruption or dropped writes.
**Why it happens:** SIGTERM/SIGINT handlers need to explicitly drain the connection pool.
**How to avoid:** Handle `SIGTERM`/`SIGINT` signals. Call `sql.end()` (postgres.js cleanup) before `process.exit()`. D-51 requires this.
**Warning signs:** Truncated data, missing memories that were "saved" just before shutdown.

### Pitfall 9: Similarity Score Calculation Off By One

**What goes wrong:** `cosineDistance()` returns a distance (0 = identical), not a similarity (1 = identical). Returning distance directly confuses agents.
**Why it happens:** Distance and similarity are inverses.
**How to avoid:** Always compute `similarity = 1 - cosineDistance()`. The pattern is `` sql<number>`1 - (${cosineDistance(col, vec)})` ``.
**Warning signs:** Highly relevant results show score near 0, irrelevant results show score near 1.

### Pitfall 10: Auto-Migrate in Tests Causes Conflicts

**What goes wrong:** Multiple test suites running concurrently each try to migrate, causing lock contention.
**Why it happens:** D-53 says auto-migrate on startup, D-61 says real Postgres in tests.
**How to avoid:** Run migrations once in a global test setup (vitest `globalSetup`), not per-test. Truncate tables between suites (D-64), not re-migrate.
**Warning signs:** Test timeouts, `deadlock detected` errors.

## Code Examples

### MCP Server Entry Point (D-50, D-51, D-52)

```typescript
// src/server.ts
// Source: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createEmbeddingProvider } from "./providers/embedding/index.js";

const VERSION = "0.1.0";

async function main() {
  console.error(`[agentic-brain] v${VERSION} starting...`);

  // Initialize database
  const db = createDb(process.env.DATABASE_URL!);
  await runMigrations(db);
  console.error(`[agentic-brain] Database connected, migrations applied`);

  // Initialize embedding provider
  const embedder = createEmbeddingProvider();
  console.error(
    `[agentic-brain] Embedding provider: ${embedder.modelName} (${embedder.dimensions}d)`,
  );

  // Create MCP server
  const server = new McpServer({ name: "agentic-brain", version: VERSION });
  registerAllTools(server, db, embedder);

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[agentic-brain] Server ready on stdio`);

  // Graceful shutdown (D-51)
  const shutdown = async () => {
    console.error(`[agentic-brain] Shutting down...`);
    await server.close();
    await db.$client.end(); // postgres.js cleanup
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(`[agentic-brain] Fatal error:`, err);
  process.exit(1);
});
```

### Drizzle Database Initialization

```typescript
// src/db/index.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10, // connection pool size
    idle_timeout: 20,
  });
  return drizzle(client, { schema });
}
```

### Amazon Titan V2 Embedding Call

```typescript
// src/providers/embedding/titan.ts
// Source: https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingProvider } from "./types.js";

export class TitanEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "amazon.titan-embed-text-v2:0";
  readonly dimensions = 512;
  private client: BedrockRuntimeClient;

  constructor(region: string = "us-east-1", timeoutMs: number = 10000) {
    this.client = new BedrockRuntimeClient({
      region,
      requestHandler: { requestTimeout: timeoutMs },
    });
  }

  async embed(text: string): Promise<number[]> {
    const truncated = text.slice(0, 32000); // ~8192 tokens safety margin
    const command = new InvokeModelCommand({
      modelId: this.modelName,
      body: JSON.stringify({
        inputText: truncated,
        dimensions: this.dimensions,
        normalize: true,
      }),
      contentType: "application/json",
      accept: "application/json",
    });

    const response = await this.client.send(command);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    return body.embedding as number[];
  }
}
```

### Docker Compose (D-58)

```yaml
# docker-compose.yml
services:
  postgres:
    image: pgvector/pgvector:pg17
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: agentic
      POSTGRES_PASSWORD: agentic
      POSTGRES_DB: agentic_brain
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

### .env.example (D-63)

```bash
# Database
DATABASE_URL=postgresql://agentic:agentic@localhost:5432/agentic_brain

# Embedding provider: titan | mock
EMBEDDING_PROVIDER=mock

# AWS (only needed when EMBEDDING_PROVIDER=titan)
AWS_REGION=us-east-1
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from credential chain

# Embedding timeout (ms)
EMBEDDING_TIMEOUT_MS=10000
```

### Vitest Global Setup for DB Tests (D-61, D-64)

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    hookTimeout: 30000,
  },
});
```

```typescript
// tests/global-setup.ts
import { spawn } from "child_process";

export async function setup() {
  // Ensure Docker Postgres is running
  await runCommand("docker", ["compose", "up", "-d", "--wait"]);
  // Run migrations once for all tests
  await runCommand("npx", ["drizzle-kit", "migrate"]);
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit" });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}
```

### Test Table Truncation Helper (D-64)

```typescript
// tests/helpers.ts
import { sql } from "drizzle-orm";

export async function truncateAll(db: ReturnType<typeof createDb>) {
  await db.execute(sql`TRUNCATE TABLE memories, projects CASCADE`);
}
```

## State of the Art

| Old Approach                                       | Current Approach                                 | When Changed   | Impact                                                       |
| -------------------------------------------------- | ------------------------------------------------ | -------------- | ------------------------------------------------------------ |
| pgvector 0.7.x sequential scan on filtered queries | pgvector 0.8.0 iterative index scans             | Nov 2024       | Filtered HNSW queries now work correctly without workarounds |
| Drizzle hand-rolled vector SQL                     | Drizzle built-in `vector()` + `cosineDistance()` | v0.31.0 (2024) | No more raw SQL for vector operations                        |
| MCP SDK `server.setRequestHandler()`               | `McpServer.registerTool()` high-level API        | SDK 1.x        | Simpler tool registration with Zod schemas                   |
| zod v3 only for MCP SDK                            | MCP SDK 1.27.x supports zod v3.25+ and v4        | 2025           | Use zod 4.x for new projects, no compatibility issue         |
| Jest for TypeScript testing                        | Vitest 4.x                                       | 2024-2025      | ESM-native, no transform hacks, faster                       |

**Deprecated/outdated:**

- `drizzle-orm 1.0 beta` / `drizzle-kit 1.0 beta`: Breaking migration changes, multiple beta releases per day. Do not use.
- `TypeScript 6.0 RC`: Not stable. Last JS-based compiler before Go rewrite.
- `IVFFlat` indexes for pgvector: HNSW is superior for this scale. IVFFlat requires reindexing after inserts.

## Open Questions

1. **User identity transport mechanism (D-38 discretion)**
   - What we know: `user_id` is required on all write operations. `project_id` is per-call.
   - What's unclear: Should `user_id` be a per-call parameter (like `project_id`) or an env var set at server startup?
   - Recommendation: Make it a per-call parameter for consistency with `project_id`. An agent may switch user context. If it becomes noisy, a default from env can be added later.

2. **Auto-generated title strategy (D-03)**
   - What we know: Title is optional. If omitted, auto-generate from content.
   - What's unclear: "First N chars" vs "summarization" (LLM call would add latency).
   - Recommendation: Use first 80 characters of content, trimmed at word boundary, with "..." suffix. Simple, fast, no LLM dependency. Can be enhanced later.

3. **User-scoped memory query pattern (SCOP-02)**
   - What we know: User-scoped memories follow the user across projects. Scope is per-memory.
   - What's unclear: When scope is "user", should search/list filter by `author` field instead of `project_id`?
   - Recommendation: When `scope = "user"`, filter by `author = user_id` (read caller) instead of `project_id`. This means user memories are tied to their author, visible regardless of project.

4. **pgvector extension creation in migrations**
   - What we know: `CREATE EXTENSION IF NOT EXISTS vector;` must run before any vector columns.
   - What's unclear: Whether Drizzle Kit handles this in generated migrations or if it needs a custom migration.
   - Recommendation: Use a custom first migration (SQL file in `drizzle/` directory) that creates the extension. Drizzle Kit does not auto-generate extension creation.

## Environment Availability

| Dependency     | Required By             | Available | Version                        | Fallback                                       |
| -------------- | ----------------------- | --------- | ------------------------------ | ---------------------------------------------- |
| Node.js        | Runtime                 | Yes       | 25.8.1 (dev) / target 22.x LTS | Works on 25.x; production should use 22.x LTS  |
| npm            | Package management      | Yes       | 11.12.0                        | --                                             |
| Docker         | Local Postgres          | Yes       | 28.3.3                         | --                                             |
| Docker Compose | Container orchestration | Yes       | 2.39.2                         | --                                             |
| AWS CLI        | Credential verification | Yes       | 2.34.14                        | Not strictly needed; SDK uses credential chain |
| psql           | DB debugging            | Yes       | 18.3                           | Not required for app; useful for debugging     |

**Missing dependencies with no fallback:**

- None. All required dependencies are available.

**Missing dependencies with fallback:**

- None.

**Note:** Dev machine has Node.js 25.8.1 instead of the recommended 22.x LTS. This is forward-compatible -- all libraries support Node 22+ and Node 25 is a superset. No action needed for development, but production deployments should target 22.x LTS.

## Validation Architecture

### Test Framework

| Property           | Value                                             |
| ------------------ | ------------------------------------------------- |
| Framework          | Vitest 4.1.0                                      |
| Config file        | `vitest.config.ts` (does not exist yet -- Wave 0) |
| Quick run command  | `npx vitest run --reporter=verbose`               |
| Full suite command | `npx vitest run --coverage`                       |

### Phase Requirements -> Test Map

| Req ID  | Behavior                                  | Test Type   | Automated Command                                                      | File Exists? |
| ------- | ----------------------------------------- | ----------- | ---------------------------------------------------------------------- | ------------ |
| INFR-01 | MCP server exposes tools via stdio        | integration | `npx vitest run tests/integration/mcp-server.test.ts -t "lists tools"` | Wave 0       |
| INFR-02 | Storage layer behind interface            | unit        | `npx vitest run tests/unit/memory-repository.test.ts`                  | Wave 0       |
| INFR-03 | Embedding provider behind interface       | unit        | `npx vitest run tests/unit/embedding-provider.test.ts`                 | Wave 0       |
| INFR-04 | pgvector HNSW index exists                | integration | `npx vitest run tests/integration/schema.test.ts -t "HNSW index"`      | Wave 0       |
| INFR-05 | Migrations run programmatically           | integration | `npx vitest run tests/integration/migrations.test.ts`                  | Wave 0       |
| CORE-01 | Save memory with content/title/tags       | integration | `npx vitest run tests/integration/memory-create.test.ts`               | Wave 0       |
| CORE-02 | Retrieve memory by ID                     | integration | `npx vitest run tests/integration/memory-get.test.ts`                  | Wave 0       |
| CORE-03 | Update memory (partial, re-embed)         | integration | `npx vitest run tests/integration/memory-update.test.ts`               | Wave 0       |
| CORE-04 | Archive memory (soft delete, drop vector) | integration | `npx vitest run tests/integration/memory-archive.test.ts`              | Wave 0       |
| CORE-05 | Semantic search with ranked results       | integration | `npx vitest run tests/integration/memory-search.test.ts`               | Wave 0       |
| CORE-06 | Tag memories with type enum + tags        | integration | `npx vitest run tests/integration/memory-create.test.ts -t "tags"`     | Wave 0       |
| CORE-07 | Memories persist in Postgres              | integration | `npx vitest run tests/integration/memory-create.test.ts -t "persist"`  | Wave 0       |
| CORE-08 | Raw text stored alongside embeddings      | integration | `npx vitest run tests/integration/memory-create.test.ts -t "raw text"` | Wave 0       |
| CORE-09 | Embedding metadata stored per memory      | integration | `npx vitest run tests/integration/memory-create.test.ts -t "metadata"` | Wave 0       |
| SCOP-01 | Memories scoped to project                | integration | `npx vitest run tests/integration/scoping.test.ts -t "project scope"`  | Wave 0       |
| SCOP-02 | User-scoped memories cross-project        | integration | `npx vitest run tests/integration/scoping.test.ts -t "user scope"`     | Wave 0       |
| SCOP-04 | No cross-project leakage                  | integration | `npx vitest run tests/integration/scoping.test.ts -t "no leakage"`     | Wave 0       |

### Sampling Rate

- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run --coverage`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `vitest.config.ts` -- framework config with globalSetup
- [ ] `tests/global-setup.ts` -- Docker Postgres start + migration runner
- [ ] `tests/helpers.ts` -- truncateAll helper, test DB factory
- [ ] `tests/integration/memory-create.test.ts` -- CORE-01, CORE-06, CORE-07, CORE-08, CORE-09
- [ ] `tests/integration/memory-get.test.ts` -- CORE-02
- [ ] `tests/integration/memory-update.test.ts` -- CORE-03
- [ ] `tests/integration/memory-archive.test.ts` -- CORE-04
- [ ] `tests/integration/memory-search.test.ts` -- CORE-05
- [ ] `tests/integration/memory-list.test.ts` -- D-07, D-45, D-46, D-48
- [ ] `tests/integration/memory-verify.test.ts` -- D-11
- [ ] `tests/integration/memory-list-stale.test.ts` -- D-12
- [ ] `tests/integration/scoping.test.ts` -- SCOP-01, SCOP-02, SCOP-04
- [ ] `tests/integration/mcp-server.test.ts` -- INFR-01 (tool listing, basic invocation)
- [ ] `tests/unit/embedding-provider.test.ts` -- INFR-03 (mock provider, interface contract)
- [ ] `tests/unit/memory-repository.test.ts` -- INFR-02 (repository interface)
- [ ] `tests/integration/schema.test.ts` -- INFR-04 (HNSW index verification)
- [ ] `tests/integration/migrations.test.ts` -- INFR-05

## Project Constraints (from CLAUDE.md)

The following directives from CLAUDE.md are authoritative for planning:

1. **console.log is forbidden in MCP stdio servers** -- use `console.error()` exclusively
2. **Do NOT use drizzle-orm 1.0 beta or drizzle-kit 1.0 beta** -- stick with 0.45.x / 0.31.x
3. **Do NOT use TypeScript 6.0 RC** -- use 5.9.x
4. **Do NOT use LangChain.js, Prisma, Mem0 as dependency, dedicated vector DBs**
5. **Use `StdioServerTransport`** for Phase 1
6. **Entry point:** `npx tsx src/server.ts`
7. **All logging to stderr** via `console.error()`
8. **512 dimensions** for embeddings
9. **HNSW index defaults:** m=16, ef_construction=64
10. **Drizzle ORM with built-in pgvector support** -- no raw SQL unless ORM gets in the way
11. **postgres.js** as the Postgres driver (not node-postgres)
12. **Abstract embedding behind `EmbeddingProvider` interface**
13. **GSD Workflow Enforcement** -- all file changes through GSD commands

## Sources

### Primary (HIGH confidence)

- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) -- `McpServer`, `registerTool()`, `StdioServerTransport` API
- [MCP SDK server docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) -- Tool registration patterns, error handling, context parameter
- [MCP SDK npm v1.27.1](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- Verified latest stable
- [Drizzle ORM pgvector guide](https://orm.drizzle.team/docs/guides/vector-similarity-search) -- `vector()`, `cosineDistance()`, HNSW index
- [Drizzle ORM pgvector extension docs](https://orm.drizzle.team/docs/extensions/pg#pg_vector) -- Column definitions, index ops
- [Drizzle ORM cursor pagination](https://orm.drizzle.team/docs/guides/cursor-based-pagination) -- Keyset pagination patterns
- [Drizzle ORM PostgreSQL column types](https://orm.drizzle.team/docs/column-types/pg) -- pgEnum, jsonb, timestamp, text, vector
- [pgvector-node GitHub](https://github.com/pgvector/pgvector-node) -- Drizzle integration, `toSql()`, v0.2.1
- [AWS Titan Text Embeddings V2 docs](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html) -- Model ID, dimensions, request format
- [postgres.js GitHub v3.4.8](https://github.com/porsager/postgres) -- Driver features, connection pooling

### Secondary (MEDIUM confidence)

- [MCP Tools spec](https://modelcontextprotocol.io/legacy/concepts/tools) -- `isError` field, `CallToolResult` structure
- [MCP error handling patterns](https://dev.to/yigit-konur/error-handling-in-mcp-typescript-sdk-2ol7) -- Domain errors vs protocol errors
- npm registry version checks (all packages verified 2026-03-23)

### Tertiary (LOW confidence)

- None -- all findings verified against primary sources.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH -- all versions verified against npm registry, compatibility confirmed in CLAUDE.md
- Architecture: HIGH -- patterns drawn from official SDK docs, Drizzle guides, and standard MCP server structure
- Pitfalls: HIGH -- each pitfall verified against official documentation or known library behavior

**Research date:** 2026-03-23
**Valid until:** 2026-04-23 (stable stack, no fast-moving dependencies)
