# Architecture Research

**Domain:** AI Agent Long-Term Memory System (MCP Server)
**Researched:** 2026-03-23
**Confidence:** HIGH

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Agent Integration Layer                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Claude Code │  │   Cursor   │  │  Copilot   │  │ Custom Agent │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └──────┬───────┘  │
│        │               │               │                │           │
│        └───────────┬───┴───────────────┴────────────────┘           │
│                    │ MCP Protocol (stdio / Streamable HTTP)         │
├────────────────────┴────────────────────────────────────────────────┤
│                        MCP Server Layer                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  McpServer (TypeScript SDK)                                  │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ │   │
│  │  │ save_note  │ │search_memory│ │ get_note   │ │update_note│ │   │
│  │  └────────────┘ └────────────┘ └────────────┘ └──────────┘ │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ │   │
│  │  │archive_note│ │comment_note│ │verify_note │ │list_stale│ │   │
│  │  └────────────┘ └────────────┘ └────────────┘ └──────────┘ │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │                                       │
├─────────────────────────────┴───────────────────────────────────────┤
│                        Core Services Layer                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Memory       │  │ Retrieval    │  │ Lifecycle                │  │
│  │ Service      │  │ Service      │  │ Service                  │  │
│  │ (write path) │  │ (read path)  │  │ (stale, verify, archive) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘  │
│         │                 │                      │                  │
├─────────┴─────────────────┴──────────────────────┴──────────────────┤
│                        Provider Abstraction Layer                    │
│  ┌────────────────────┐  ┌────────────────────────────────────────┐ │
│  │ EmbeddingProvider  │  │ StorageProvider                        │ │
│  │ (interface)        │  │ (interface)                            │ │
│  │ ┌────────────────┐ │  │ ┌──────────────────────────────────┐  │ │
│  │ │ TitanProvider  │ │  │ │ PgVectorStore                    │  │ │
│  │ │ (Bedrock)      │ │  │ │ (Postgres + pgvector)            │  │ │
│  │ └────────────────┘ │  │ └──────────────────────────────────┘  │ │
│  │ ┌────────────────┐ │  │ ┌──────────────────────────────────┐  │ │
│  │ │ OpenAIProvider │ │  │ │ (future: SQLite, other stores)   │  │ │
│  │ │ (future)       │ │  │ └──────────────────────────────────┘  │ │
│  │ └────────────────┘ │  │                                       │ │
│  └────────────────────┘  └────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│                        Data Layer                                    │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ PostgreSQL + pgvector                                         │  │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │  │
│  │ │ memories │ │ projects │ │  users   │ │ HNSW vector index│  │  │
│  │ └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │  │
│  │ Row-Level Security (tenant isolation)                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Amazon Bedrock (Titan Embeddings v2)                          │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component         | Responsibility                                                                                 | Typical Implementation                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| MCP Server        | Protocol handling, tool registration, transport management, request routing, input validation  | `McpServer` from `@modelcontextprotocol/sdk`, Zod schemas for validation             |
| Memory Service    | Write path: validate input, generate embeddings, store memory, handle scoping (project/user)   | Service class orchestrating embedding + storage providers                            |
| Retrieval Service | Read path: embed query, vector similarity search, optional keyword matching, relevance scoring | Service class using storage provider for hybrid search                               |
| Lifecycle Service | Staleness tracking, verification timestamps, archival, listing stale notes                     | Service class operating on metadata fields (verified_at, archived_at)                |
| EmbeddingProvider | Generate vector embeddings from text, abstract over embedding model differences                | Interface with `embed(text) -> vector` method; TitanProvider as default impl         |
| StorageProvider   | CRUD operations for memories, vector similarity search, scoped queries, RLS enforcement        | Interface with save/search/get/update/archive methods; PgVectorStore as default impl |
| Auth Layer        | Resolve user/project context from MCP connection, enforce access control                       | Tenant context from connection metadata or environment; RLS at DB level              |

## Recommended Project Structure

```
agent-brain/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts               # Entry point: McpServer init, tool registration, transport
│   ├── server.ts              # McpServer setup, connects tools to services
│   ├── tools/                 # MCP tool definitions (one file per tool or logical group)
│   │   ├── memory-tools.ts    # save_note, get_note, update_note, comment_note
│   │   ├── search-tools.ts    # search_memory
│   │   └── lifecycle-tools.ts # verify_note, archive_note, list_stale
│   ├── services/              # Business logic layer
│   │   ├── memory-service.ts  # Write path orchestration
│   │   ├── retrieval-service.ts # Read path orchestration
│   │   └── lifecycle-service.ts # Staleness, verification, archival
│   ├── providers/             # Abstracted external integrations
│   │   ├── embedding/
│   │   │   ├── embedding-provider.ts  # Interface definition
│   │   │   └── titan-provider.ts      # Amazon Titan via Bedrock impl
│   │   └── storage/
│   │       ├── storage-provider.ts    # Interface definition
│   │       └── pgvector-store.ts      # Postgres + pgvector impl
│   ├── auth/                  # Authentication and tenant resolution
│   │   ├── auth-context.ts    # User/project context resolution
│   │   └── scoping.ts         # Project-level vs user-level memory scoping
│   ├── schemas/               # Zod validation schemas for tool inputs
│   │   └── memory-schemas.ts  # All input schemas
│   ├── types/                 # TypeScript type definitions
│   │   └── index.ts           # Memory, Project, User, SearchResult types
│   └── config.ts              # Environment config with validation
├── migrations/                # Database migration files
│   └── 001_initial_schema.sql
└── tests/
    ├── services/
    ├── providers/
    └── tools/
```

### Structure Rationale

- **tools/:** Thin layer that maps MCP protocol to service calls. Owns Zod schemas for input validation and response formatting. Contains no business logic -- just wiring.
- **services/:** Where domain logic lives. Orchestrates providers. Testable in isolation without MCP protocol concerns. Separated by read/write/lifecycle to keep responsibilities clear.
- **providers/:** Interface + implementation pairs. Each provider is independently swappable. Embedding and storage are separate concerns that evolve independently (you might swap Titan for OpenAI without touching Postgres).
- **auth/:** Isolated so auth strategy can change (env vars today, OAuth tomorrow) without touching business logic.
- **schemas/:** Centralized Zod schemas. Used by tools for validation and by services for type inference. Single source of truth for input shapes.

## Architectural Patterns

### Pattern 1: Provider Interface Abstraction

**What:** Define interfaces for external dependencies (embedding, storage) and code against those interfaces. Concrete implementations are injected at startup.

**When to use:** Any external dependency that the project requirements say should be swappable. This project explicitly requires swappable storage and embedding providers.

**Trade-offs:** Adds a layer of indirection, but the project constraints demand it. Keep interfaces minimal (5-7 methods max) to avoid abstraction bloat.

**Example:**

```typescript
// providers/embedding/embedding-provider.ts
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

// providers/embedding/titan-provider.ts
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export class TitanEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1024; // Titan v2 default
  private client: BedrockRuntimeClient;

  constructor(region: string) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async embed(text: string): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: "amazon.titan-embed-text-v2:0",
      contentType: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions: this.dimensions,
        normalize: true,
      }),
    });
    const response = await this.client.send(command);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    return body.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
```

### Pattern 2: Scoped Memory Access via Tenant Context

**What:** Every database query is scoped by project and/or user. Tenant context is resolved at the MCP connection boundary and threaded through all service calls. PostgreSQL Row-Level Security enforces isolation at the database level as a safety net.

**When to use:** Always. This is not optional -- multi-tenant memory without isolation is a data leak.

**Trade-offs:** RLS adds a small query planning overhead (~1-2ms). Worth it for guaranteed isolation. Application-level filtering is also applied as defense-in-depth, but RLS is the enforcement layer.

**Example:**

```typescript
// auth/auth-context.ts
export interface AuthContext {
  userId: string;
  projectId: string;
}

// In the storage provider, every query sets the session context:
async withTenantContext(ctx: AuthContext, fn: () => Promise<T>): Promise<T> {
  await this.pool.query("SET app.current_project_id = $1", [ctx.projectId]);
  await this.pool.query("SET app.current_user_id = $1", [ctx.userId]);
  return fn();
}
```

### Pattern 3: Service Layer Orchestration

**What:** Tools are thin dispatchers. Services contain business logic. Providers handle external I/O. This three-layer separation keeps each concern testable and replaceable.

**When to use:** Always. Even for a project this size, the separation pays off immediately in testability.

**Trade-offs:** More files than a "put everything in the tool handler" approach. But tool handlers that embed, store, and search in one function become untestable and unswappable.

**Example:**

```typescript
// services/memory-service.ts
export class MemoryService {
  constructor(
    private embedding: EmbeddingProvider,
    private storage: StorageProvider,
  ) {}

  async saveNote(
    ctx: AuthContext,
    content: string,
    metadata: NoteMetadata,
  ): Promise<Note> {
    const vector = await this.embedding.embed(content);
    const note = await this.storage.save(ctx, {
      content,
      vector,
      metadata,
      scope: metadata.scope ?? "project",
      createdBy: ctx.userId,
      createdAt: new Date(),
    });
    return note;
  }
}

// tools/memory-tools.ts -- thin tool wiring
server.registerTool(
  "save_note",
  {
    description: "Save a new memory note",
    inputSchema: SaveNoteSchema,
  },
  async (params) => {
    const ctx = resolveAuthContext(); // from MCP connection
    const note = await memoryService.saveNote(
      ctx,
      params.content,
      params.metadata,
    );
    return { content: [{ type: "text", text: `Saved note ${note.id}` }] };
  },
);
```

## Data Flow

### Write Flow (save_note)

```
Agent calls save_note via MCP
    |
    v
MCP Server: validate input (Zod schema)
    |
    v
Auth Context: resolve userId + projectId from connection
    |
    v
Memory Service: orchestrate write
    |
    ├──> EmbeddingProvider.embed(content) ──> Bedrock Titan API
    |         |
    |         v
    |    vector (1024-dim float[])
    |
    └──> StorageProvider.save(ctx, note + vector)
              |
              v
         PostgreSQL: INSERT into memories table
         (RLS enforces project_id = session project)
         pgvector: vector stored in embedding column
         HNSW index updated automatically
```

### Read Flow (search_memory)

```
Agent calls search_memory via MCP
    |
    v
MCP Server: validate input (Zod schema)
    |
    v
Auth Context: resolve userId + projectId
    |
    v
Retrieval Service: orchestrate search
    |
    ├──> EmbeddingProvider.embed(query) ──> Bedrock Titan API
    |         |
    |         v
    |    query vector (1024-dim float[])
    |
    └──> StorageProvider.search(ctx, queryVector, filters)
              |
              v
         PostgreSQL: vector similarity search
         ORDER BY embedding <=> query_vector
         WHERE project_id = session project (RLS)
         AND (scope = 'project' OR (scope = 'user' AND user_id = session user))
         AND archived_at IS NULL
         LIMIT k
              |
              v
         Return: Note[] with relevance scores
    |
    v
Retrieval Service: filter by min_relevance, format results
    |
    v
MCP Server: return formatted text response to agent
```

### Lifecycle Flow (verify_note, archive_note, list_stale)

```
Agent calls list_stale via MCP
    |
    v
Lifecycle Service:
    SELECT * FROM memories
    WHERE verified_at < NOW() - INTERVAL '30 days'
    AND archived_at IS NULL
    AND project_id = session project (RLS)
    |
    v
Returns stale notes for agent/user review
    |
    v
Agent/user decides: verify_note (update verified_at)
                     or archive_note (set archived_at)
                     or update_note (modify content, re-embed)
```

### Key Data Flows

1. **Session-start auto-load:** Agent's CLAUDE.md instructions trigger `search_memory` at session start with broad queries. Retrieved memories augment the agent's context. This is agent-behavior driven, not server-initiated -- the MCP server is passive.

2. **Mid-session autonomous write:** Agent judges that a fact/decision is worth remembering, calls `save_note`. The system prompt in CLAUDE.md guides what is worth saving. The MCP server has no opinion about when to write -- that is the agent's judgment.

3. **Comment threading:** `comment_note` appends to an existing note's comment array. No re-embedding occurs for comments (they are metadata, not searchable content). If a note needs to be searchable by comment content, `update_note` should be used instead to merge and re-embed.

4. **Scope resolution:** Every memory has a `scope` field: `"project"` or `"user"`. Project-scoped memories are visible to all users in that project. User-scoped memories are visible only to the creating user. The storage layer enforces this via SQL WHERE clauses on top of RLS.

## Data Model

### Core Schema

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Projects table
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users table
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project membership (many-to-many)
CREATE TABLE project_members (
  project_id  UUID NOT NULL REFERENCES projects(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id)
);

-- Core memories table
CREATE TABLE memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  scope       TEXT NOT NULL CHECK (scope IN ('project', 'user')),
  title       TEXT,
  content     TEXT NOT NULL,
  embedding   vector(1024) NOT NULL,  -- Titan v2 default dimensions
  tags        TEXT[],
  comments    JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

-- HNSW index for vector similarity search
CREATE INDEX memories_embedding_idx ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Filtered search indexes
CREATE INDEX memories_project_scope_idx ON memories (project_id, scope)
  WHERE archived_at IS NULL;
CREATE INDEX memories_user_idx ON memories (user_id)
  WHERE archived_at IS NULL;
CREATE INDEX memories_verified_at_idx ON memories (verified_at)
  WHERE archived_at IS NULL;

-- Row-Level Security
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY memories_project_isolation ON memories
  USING (project_id = current_setting('app.current_project_id')::UUID);

CREATE POLICY memories_scope_visibility ON memories
  USING (
    scope = 'project'
    OR (scope = 'user' AND user_id = current_setting('app.current_user_id')::UUID)
  );
```

### Why This Schema

- **Single `memories` table:** Keeps things simple. No need for separate tables for different memory types -- they are all notes with content, embedding, and metadata. The `scope` field handles visibility.
- **Comments as JSONB array:** Comments are threaded additions, not independently searchable memories. JSONB keeps them co-located with the parent note. Structure: `[{userId, content, createdAt}]`.
- **Tags as text array:** Simple, queryable with `@>` operator, no join table needed at this scale.
- **`verified_at` defaults to creation time:** New memories are "verified" by virtue of being fresh. Staleness is detected by comparing `verified_at` to current time.
- **`archived_at` as soft delete:** Archived memories are excluded from search but retained for audit. No hard deletes.
- **HNSW index with `m=16, ef_construction=64`:** Good defaults for datasets under 1M rows. Higher `m` improves recall at the cost of memory/build time. These can be tuned later.
- **Titan v2 at 1024 dimensions:** Good balance of quality and storage cost. 1024-dim vectors at float32 = ~4KB per memory. At 100K memories, the vector column is ~400MB -- well within a small RDS instance.

## Scaling Considerations

| Scale             | Architecture Adjustments                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0-10K memories    | Single Postgres instance on RDS. HNSW index fits in memory. No optimization needed. Embedding calls at ~$0.02/1M tokens are effectively free.                                                                         |
| 10K-100K memories | Same architecture. May want to increase `ef_search` for better recall. Consider connection pooling if multiple agents hit the server concurrently.                                                                    |
| 100K-1M memories  | HNSW index may need tuning (increase `m`). Consider partitioning memories table by project_id for large multi-tenant deployments. Embedding batch operations become worthwhile.                                       |
| 1M+ memories      | Likely premature to plan for. If reached: consider halfvec (float16) to halve storage, separate read replicas, or move to a dedicated vector database like Pinecone. The provider abstraction enables this migration. |

### Scaling Priorities

1. **First bottleneck: Embedding latency.** Bedrock Titan calls take ~100-200ms per embedding. For search, this is the dominant cost. Mitigation: cache query embeddings for repeated searches, batch embeddings on bulk writes.
2. **Second bottleneck: Connection pooling.** Multiple agents connecting simultaneously via stdio each create their own server process with its own DB connection. Mitigation: use PgBouncer or RDS Proxy in transaction pooling mode (important: never statement pooling mode with RLS).
3. **Third bottleneck: HNSW index build time.** At 500K+ rows, index rebuilds get slow. Mitigation: set adequate `maintenance_work_mem` (1GB+), use iterative index scans from pgvector 0.8.0+.

## Anti-Patterns

### Anti-Pattern 1: Embedding in the Tool Handler

**What people do:** Generate embeddings, run SQL, and format responses all inside the MCP tool handler function.
**Why it is wrong:** Impossible to test without MCP protocol. Cannot swap providers. Business logic mixed with protocol concerns.
**Do this instead:** Tool handlers call services. Services call providers. Each layer is independently testable.

### Anti-Pattern 2: Application-Only Tenant Isolation

**What people do:** Add `WHERE project_id = $1` in application code but skip Row-Level Security.
**Why it is wrong:** One missed WHERE clause = data leak across projects. Application bugs can expose tenant data.
**Do this instead:** Use PostgreSQL RLS as the enforcement layer. Application-level filtering is defense-in-depth, not the primary control.

### Anti-Pattern 3: Re-embedding on Every Search

**What people do:** Embed the search query, run vector search, and return results. Even for the exact same query repeated 10 seconds later.
**Why it is wrong:** Unnecessary Bedrock API calls. Adds 100-200ms latency for identical queries.
**Do this instead:** Cache query embeddings with a short TTL (60s). Same query within the TTL skips the embedding call.

### Anti-Pattern 4: Storing Comments as Separate Memories

**What people do:** Treat each comment as a new searchable memory with its own embedding.
**Why it is wrong:** Comments are additive context on an existing note. Making them independently searchable fragments knowledge and bloats the vector index. Users expect to find the note, not the comment.
**Do this instead:** Store comments as a JSONB array on the parent note. If comment content needs to be searchable, update the parent note's content and re-embed.

### Anti-Pattern 5: Eager Knowledge Graph

**What people do:** Build entity extraction, relationship graphs, and knowledge graph traversal from day one (like the official MCP memory server or Hindsight).
**Why it is wrong:** Premature complexity. Entity extraction requires an LLM call per write (cost, latency). Knowledge graphs need maintenance (conflict resolution, deduplication). For a v1 with <10K memories, vector search on well-written notes is sufficient.
**Do this instead:** Start with vector search + metadata filtering. Add entity extraction and graph traversal later when retrieval quality degrades at scale. The architecture supports this evolution -- it is a new provider or service, not a rewrite.

## Integration Points

### External Services

| Service                   | Integration Pattern                                             | Notes                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Amazon Bedrock (Titan v2) | AWS SDK `@aws-sdk/client-bedrock-runtime`, `InvokeModelCommand` | Region-specific endpoint. IAM auth. Model ID: `amazon.titan-embed-text-v2:0`. Supports 256/512/1024 dimensions. Use 1024 for best quality. |
| PostgreSQL + pgvector     | `pg` npm package or Drizzle ORM                                 | RDS connection string via env var. Enable `vector` extension. Transaction pooling required for RLS.                                        |
| MCP Clients (Claude Code) | stdio transport, configured in `.claude/mcp.json`               | Server spawned as child process. One process per agent session. Config: `{ "command": "node", "args": ["dist/index.js"], "env": { ... } }` |
| MCP Clients (Cursor)      | stdio transport, configured in `.cursor/mcp.json`               | Same pattern as Claude Code. Same server binary.                                                                                           |

### Internal Boundaries

| Boundary                        | Communication                        | Notes                                                                                                                          |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Tools <-> Services              | Direct function call                 | Tools instantiate services at startup (dependency injection via constructor). No event bus needed at this scale.               |
| Services <-> Providers          | Direct function call via interface   | Services hold provider references. Providers are stateless (except DB connection pool).                                        |
| Services <-> Auth               | AuthContext passed as first argument | Every service method takes `AuthContext` as its first parameter. Resolved once at the tool layer from MCP connection metadata. |
| Storage Provider <-> PostgreSQL | SQL via connection pool              | Pool created at startup, shared across all storage calls. RLS session variables set per-query within a transaction.            |

### Agent Integration Architecture

The MCP server is **passive** -- it does not push memories to agents or decide when to write. Agent behavior is driven by system prompt instructions (CLAUDE.md, Cursor rules, etc.).

**Claude Code integration:**

- Server configured in `~/.claude/mcp.json` (global) or `.claude/mcp.json` (project)
- CLAUDE.md contains instructions for when to call `search_memory` and `save_note`
- Agent reads CLAUDE.md at session start, which triggers memory search
- Server process lifecycle tied to Claude Code session

**Cursor integration:**

- Server configured in `.cursor/mcp.json`
- Cursor rules file contains equivalent memory instructions
- Same MCP server binary, same protocol

**Key architectural decision:** The server exposes tools and data. The agent decides when and how to use them. Memory write triggers (mid-session saves, session-end reviews) are agent-side behaviors, not server-side features. This keeps the server simple and agent-agnostic.

### Transport Decision

**Use stdio for v1.** Rationale:

- All target agents (Claude Code, Cursor) support stdio natively
- Stdio is simpler: no HTTP server, no port management, no auth tokens
- Each agent session gets its own server process -- natural isolation
- Multi-tenancy is handled by environment variables passed at spawn time
- No network overhead: microsecond-level transport latency

**Add Streamable HTTP later if needed.** Conditions that would trigger this:

- Remote/cloud-hosted server deployment (team members not co-located)
- Web UI for memory management
- Multiple agents sharing one server process
- Need for horizontal scaling behind a load balancer

The architecture supports both transports. `src/index.ts` selects transport based on a config flag. Services and providers are transport-agnostic.

## Build Order (Dependency Chain)

Components should be built in this order based on dependencies:

```
Phase 1: Foundation
  types/             # Define Memory, Note, AuthContext types
  config.ts          # Environment configuration
  schemas/           # Zod input schemas

Phase 2: Provider Layer
  embedding-provider.ts (interface)
  titan-provider.ts (implementation)
  storage-provider.ts (interface)
  pgvector-store.ts (implementation)
  migrations/001_initial_schema.sql

Phase 3: Service Layer (depends on Phase 2)
  memory-service.ts   (depends on embedding + storage providers)
  retrieval-service.ts (depends on embedding + storage providers)
  lifecycle-service.ts (depends on storage provider)

Phase 4: MCP Server Layer (depends on Phase 3)
  server.ts           (McpServer setup)
  tools/*.ts          (tool registration, depends on services)
  index.ts            (entry point, transport, wiring)
  auth/               (context resolution from MCP connection)

Phase 5: Integration
  .claude/mcp.json    (Claude Code configuration)
  .cursor/mcp.json    (Cursor configuration)
  CLAUDE.md updates   (agent behavior instructions)
```

**Why this order:**

- Types and schemas have zero dependencies -- build them first to establish contracts
- Providers are the lowest runtime layer -- services cannot be built without them
- Services orchestrate providers -- they need working providers to function
- Tools wire MCP protocol to services -- they are the outermost layer
- Integration configuration is last because it depends on the server being runnable

## Sources

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - Official SDK, server patterns, McpServer class
- [Anthropic MCP Server Implementation Guide](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/node_mcp_server.md) - Production patterns for Node/TypeScript MCP servers
- [MCP Specification - Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) - stdio vs Streamable HTTP decision
- [Mem0 Architecture Paper](https://arxiv.org/abs/2504.19413) - Three-stage memory pipeline (extraction, consolidation, retrieval)
- [pgvector GitHub](https://github.com/pgvector/pgvector) - HNSW index configuration, dimension limits, query patterns
- [pgvector 2026 Guide](https://www.instaclustr.com/education/vector-database/pgvector-key-features-tutorial-and-pros-and-cons-2026-guide/) - Production readiness, performance characteristics
- [Amazon Titan Text Embeddings](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html) - Titan v2 dimensions, API patterns
- [MCP Security for Multi-Tenant Agents](https://prefactor.tech/blog/mcp-security-multi-tenant-ai-agents-explained) - Tenant isolation, RLS patterns, security layers
- [AWS Multi-Tenant pgvector](https://aws.amazon.com/blogs/database/self-managed-multi-tenant-vector-search-with-amazon-aurora-postgresql/) - RLS with pgvector, connection pooling considerations
- [Official MCP Memory Server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) - Knowledge graph reference implementation
- [Hindsight MCP Memory](https://hindsight.vectorize.io/blog/2026/03/04/mcp-agent-memory) - Multi-strategy retrieval, cross-encoder reranking
- [MCP Memory Service](https://github.com/doobidoo/mcp-memory-service) - Community implementation with hybrid search
- [Claude Code MCP Integration](https://code.claude.com/docs/en/mcp) - Agent-side configuration patterns

---

_Architecture research for: AI Agent Long-Term Memory System (MCP Server)_
_Researched: 2026-03-23_
