# agent-brain vs mem0

## Introduction

This document compares [agent-brain](https://github.com/cdrake/agent-brain) (a custom MCP memory server) with [mem0](https://github.com/mem0ai/mem0) (an open-source memory layer for AI agents). The goal is to decide between three options:

1. **Adopt mem0** -- replace agent-brain entirely.
2. **Wrap mem0** -- use mem0 as a backend and build missing features on top.
3. **Continue with agent-brain** -- selectively port good ideas from mem0.

### Why now

Someone recommended evaluating mem0 as an alternative. Rather than dismissing or adopting it reflexively, this document captures a structured comparison to inform the decision.

### Decision criteria

The criteria, in priority order:

1. **Maintenance burden** -- How much ongoing work does each option require? This is the primary concern. A solo maintainer cannot absorb unbounded maintenance cost.
2. **Operational complexity** -- What does deployment, monitoring, and day-to-day operation look like?
3. **Performance** -- Latency and resource consumption for typical workloads (memory creation, search, retrieval).
4. **Extensibility** -- How easy is it to add new capabilities (e.g., new memory types, integrations, storage backends)?
5. **Community health** -- Contributor activity, issue response times, release cadence, bus factor.

### Out of scope

The following are explicitly excluded from this comparison:

- **Programming language choice** -- Not a deciding factor; both projects work regardless of language preference.
- **mem0 managed platform** -- Only self-hosted deployment is relevant here.
- **Privacy and data sovereignty** -- Both options are self-hosted, so data stays local in either case.
- **Migration cost** -- This is a one-time cost and should not drive the long-term architectural decision.

## Agent-Brain

### Core model

A memory in agent-brain is a single PostgreSQL row in the `memories` table. Each row carries `id` (nanoid), `content` (free text), `title` (auto-generated from the first 80 characters of content when omitted), a typed `type` enum (`fact`, `decision`, `learning`, `pattern`, `preference`, `architecture`), a `scope` enum (`workspace`, `user`, `project`), free-form `tags` (text array), `author`, `source` (manual, agent-auto, session-review, or custom), an extensible `metadata` JSONB column, and a `version` integer for optimistic locking. Timestamps include `created_at`, `updated_at`, `verified_at`, `archived_at`, and `last_comment_at`. The `embedding` column stores a pgvector vector whose dimensionality is configurable at startup via the `EMBEDDING_DIMENSIONS` environment variable (default 768).

There are no LLM calls anywhere in the write path. When a memory is created, the service concatenates `title + "\n\n" + content`, passes that string to the configured embedding provider (a pure vector-embedding call, not a generative model), and inserts the row. If the embedding call fails, the entire create is aborted -- no partial state is ever persisted. The same re-embedding happens on updates that change content or title. This means the system never rewrites, summarizes, or extracts facts from user input; what you store is exactly what you wrote.

Before insertion, a three-stage guard chain runs: scope validation (workspace_id required for non-project scopes, project scope blocked for autonomous sources), budget checking (autonomous writes from `agent-auto` or `session-review` sources are capped per session, configurable via `WRITE_BUDGET_PER_SESSION`, default 10), and semantic duplicate detection (cosine similarity against existing memories, threshold configurable via `DUPLICATE_THRESHOLD`, default 0.90). If a near-duplicate is found, the create returns a skip result pointing to the existing memory rather than inserting a new row.

### Search and retrieval

Search works in two stages. The query text is embedded via the same provider used at write time. The repository layer runs a cosine-distance query against pgvector's HNSW index (configured with `m: 16`, `ef_construction: 64`, using `vector_cosine_ops`), over-fetching 3x the requested limit. The application layer then re-ranks those candidates with a composite scoring function and returns the top N.

The composite score formula is: `relevance = (0.80 * similarity) + (0.15 * recencyDecay) + (verified ? 0.05 : 0)`. Recency decay is exponential, halving every `RECENCY_HALF_LIFE_DAYS` (default 14). The result is clamped to [0, 1]. A minimum similarity threshold (default 0.3) filters out low-quality matches before re-ranking.

Scope filtering happens in a single SQL query. Workspace-scoped searches include workspace memories plus any project-scoped memories. User-scoped searches include the user's private memories plus project-scoped ones. A cross-scope ("both") mode unions workspace, user, and project memories in one query. All queries always filter by `project_id` for deployment isolation, and archived memories (non-null `archived_at`) are excluded everywhere.

Listing supports cursor-based pagination (fetching `limit + 1` to determine `has_more`), filtering by type and tags (via `arrayOverlaps`), and sorting by `created_at` or `updated_at` in either direction. Additional indexes exist on `project_id`, `workspace_id`, `author`, `type`, and `created_at`.

### LLM integration

The only AI/ML integration is vector embedding for semantic search. No generative LLM is called at any point. The embedding provider is behind a three-method interface (`embed`, `modelName`, `dimensions`) and is selected at startup via the `EMBEDDING_PROVIDER` environment variable.

Three providers ship with the codebase. **Ollama** calls a local Ollama instance (default model: `nomic-embed-text`, 768 dimensions) over HTTP. **Amazon Titan** uses `amazon.titan-embed-text-v2:0` via the AWS Bedrock SDK, supporting 256, 512, or 1024 dimensions with a 10-second timeout. **Mock** generates deterministic vectors from a hash of the input text, used for development and testing. Adding a new provider means implementing the `EmbeddingProvider` interface (one async method plus two readonly properties) and adding a case to the factory switch.

### Deployment and operations

The server runs as a Node.js process (Node 22, TypeScript via tsx) exposing a stateless MCP endpoint over Streamable HTTP on `/mcp`. Each incoming POST creates a fresh `StreamableHTTPServerTransport` with no session tracking (`sessionIdGenerator: undefined`). SSE and session termination endpoints return 405. An Express app provides DNS rebinding protection via `createMcpExpressApp` from the MCP SDK.

Infrastructure requires PostgreSQL with pgvector and an embedding provider. The `docker-compose.yml` defines PostgreSQL 17 (pgvector image) and Ollama with automatic model pull of `nomic-embed-text`. The `docker-compose.prod.yml` extends this with the application container itself, configured with health checks against `/health`. The Dockerfile is a two-stage build: dependencies installed with `npm ci --omit=dev`, then the application layer with `curl` added for health checks. The container runs on port 19898.

Database migrations run automatically on startup via Drizzle Kit. The health endpoint (`GET /health`) returns `{ status: "ok" }` -- no deeper checks against the database or embedding provider. Graceful shutdown closes the database connection on SIGTERM/SIGINT.

For the Titan provider, the only additional requirement is AWS credentials and Bedrock access in the configured region. For Ollama, the only requirement is a running Ollama instance. The mock provider needs nothing, making local development possible with just PostgreSQL.

### Multi-user support

Tenancy is structured as deployment > project > workspace > user. The `project_id` is set once at server startup via the `PROJECT_ID` environment variable and hard-codes deployment-level isolation -- every query filters by it, and cross-project access returns "not found" rather than "forbidden" to avoid leaking existence. Within a project, workspaces are identified by human-readable slugs and auto-created on first use.

The three scopes control visibility. **Workspace** memories are visible to anyone querying that workspace. **User** memories are private: only the author can read, modify, or search them, and non-owners get "not found" errors. **Project** memories span all workspaces within the deployment and are visible to everyone, but they cannot be created by autonomous sources (agent-auto, session-review) -- they require explicit user confirmation.

There is no authentication layer. The `user_id` parameter is passed by the calling agent on every request and trusted as-is. Access control is enforced in the service layer: `canAccess` checks scope and authorship, `assertCanModify` gates mutations. The system relies on the MCP client (the AI coding assistant) to pass the correct user identity.

### Memory lifecycle

Memories age. The `verified_at` timestamp records when someone last confirmed a memory is still accurate, and `verified_by` records who did it. The `memory_list_stale` tool finds memories that have never been verified or whose verification is older than a configurable threshold (default 30 days), with cursor-based pagination for working through large backlogs. Verification gives a 5% relevance boost in search scoring, creating a soft incentive to maintain the knowledge base.

Archival is a soft delete: `archived_at` is set and the embedding vector is nulled out (freeing storage in the pgvector index). Archived memories are excluded from all search and list queries. Archiving is idempotent -- archiving an already-archived memory is a no-op. Batch archival is supported (the tool accepts a single ID or an array).

The write budget system limits autonomous agents. Each session gets a budget (default 10 writes), tracked in the `sessions` table. The budget counter increments atomically with a `WHERE budget_used < limit` guard to prevent race conditions. Manual writes (`source: 'manual'`) bypass the budget entirely. When the budget is exceeded, the create call returns a skip result with a message suggesting the user force-save with source `manual`.

Duplicate detection runs on every create. The system computes cosine similarity between the new memory's embedding and existing memories in the same scope, returning a skip result if similarity exceeds the threshold (default 0.90). User-scoped dedup also checks against workspace-scoped memories to catch cases where private knowledge duplicates shared knowledge.

Updates use optimistic locking via the `version` field. The update query includes `WHERE version = expectedVersion`, and a version mismatch throws a `ConflictError`. The version increments on every successful update.

### Collaboration

The comment system turns memories into threaded discussions. Comments are append-only: they cannot be edited or deleted. Each comment records author, content, and timestamp. The system enforces a no-self-comment rule -- you cannot comment on your own memories (the tool directs you to use `memory_update` instead). User-scoped memories cannot receive comments at all, since the only person with access is the owner, who would be self-commenting. Comments on archived memories are blocked.

Soft limits exist at 50 comments per memory and 1000 characters per comment, logged as warnings but not enforced as hard errors. The `comment_count` is computed via a correlated subquery on every memory read (not denormalized), and `last_comment_at` is stored on the memory row for change-type detection.

The `memory_list_recent` tool shows team activity: memories created, updated, or commented since a given timestamp. Each result carries a `change_type` field (`created`, `updated`, or `commented`) derived from timestamp comparisons. The `exclude_self` flag filters out the requesting user's own activity, answering "what did my teammates do?"

Session start (`memory_session_start`) bootstraps context for a new agent session. It auto-creates the workspace, generates a session ID for budget tracking, records the user's session timestamp, and returns either a semantic search (if context is provided) or recent memories ranked by the composite score. It also returns `team_activity` counts -- new, updated, and commented memories since the user's last session -- giving the agent immediate awareness of what changed.

The `memory_get` response includes capability booleans (`can_edit`, `can_archive`, `can_verify`, `can_comment`) so the calling agent knows what actions are available without trial and error.

### Extensibility

The embedding provider is the primary extension point. The `EmbeddingProvider` interface is three members: `embed(text: string): Promise<number[]>`, `modelName: string`, and `dimensions: number`. Adding a new backend (OpenAI, Cohere, a local ONNX model) means writing one class and adding one case to the factory function in `src/providers/embedding/index.ts`. The vector dimensionality is configured at startup and stored per-memory, so switching providers does not require re-embedding existing data (though mixed dimensions in the same table would break cosine distance queries).

The `metadata` JSONB column on memories is schemaless and available for any integration-specific data (file paths, URLs, commit hashes, whatever the client wants to store). The `source` field is a free-form string, not an enum, so new ingestion mechanisms can tag their output without schema changes.

The server exposes both MCP tools (for AI agent consumption) and REST routes (for programmatic integration). The health endpoint is already there; adding webhook receivers or batch APIs means adding Express routes alongside the MCP transport.

The database layer uses Drizzle ORM with typed schemas and generated migrations, so schema evolution follows a standard migration workflow rather than manual SQL.

### Community

Agent-brain is a solo-maintainer project. The git history shows one primary contributor with approximately 260 commits. The codebase is at version 0.1.0. There is no public issue tracker activity, no external contributors, and no published release cadence. The project is purpose-built for a specific workflow (AI coding assistant memory via MCP) rather than designed as a general-purpose library.

### Maintenance surface

The production dependency list is deliberately small: 10 packages. The core stack is `@modelcontextprotocol/sdk` for the MCP transport, `drizzle-orm` and `postgres` for database access, `pgvector` for vector operations, `express` for HTTP, `zod` for validation, `nanoid` for ID generation, `dotenv` for configuration, `tsx` for TypeScript execution, and `@aws-sdk/client-bedrock-runtime` for the Titan embedding provider. Development dependencies add ESLint, Prettier, Vitest, TypeScript, Drizzle Kit, and Husky.

The non-test TypeScript source totals approximately 3,700 lines across 41 files. The architecture is layered: tools (MCP interface) call a service layer, which calls repository classes, which use Drizzle to talk to PostgreSQL. There is no ORM magic, no dependency injection framework, no runtime code generation. The scoring algorithm is pure functions. The embedding providers are simple HTTP or SDK wrappers.

What you own is everything. There is no upstream to absorb bug fixes or feature work. If pgvector changes its API, if the MCP SDK releases a breaking change, if a new embedding model needs a different vector format -- all of that is your maintenance burden. The tradeoff is total control: every behavior is visible in the source, every decision is yours to change, and the system does exactly what it was built to do with no surplus abstraction.
