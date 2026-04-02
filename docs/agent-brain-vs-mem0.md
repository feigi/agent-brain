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

## mem0

### Core model

A memory in mem0 is a vector-store record whose primary content is a short textual fact, not the raw user input. Each `MemoryItem` (a Pydantic model) carries an `id`, `memory` (the text), an MD5 `hash` of that text, `created_at` and `updated_at` timestamps (UTC-normalized ISO strings), and an optional `score` populated during search. Session identifiers -- `user_id`, `agent_id`, `run_id` -- are promoted to top-level fields alongside `actor_id` and `role`. Any remaining payload fields land in a `metadata` dict. There is no typed category or scope enum; organization is entirely by these session identifiers.

The write path is LLM-driven by default. When `add()` is called with `infer=True` (the default), the input -- which can be a plain string, a single message dict, or a list of message dicts -- is first normalized into a conversation transcript. That transcript is sent to the configured LLM with a fact-extraction prompt (the `FACT_RETRIEVAL_PROMPT` in `mem0/configs/prompts.py`), which instructs the model to act as a "Personal Information Organizer" and return a JSON object with a `facts` array. There are separate extraction prompts for user messages (`USER_MEMORY_EXTRACTION_PROMPT`) and agent/assistant messages (`AGENT_MEMORY_EXTRACTION_PROMPT`), selected based on whether an `agent_id` is provided and whether the messages include an assistant role. A third variant, `PROCEDURAL_MEMORY_SYSTEM_PROMPT`, handles `memory_type="procedural_memory"` by generating execution summaries rather than facts.

After extraction, each fact is embedded and searched against the vector store (limit 5 per fact) to find existing memories that might overlap. The retrieved candidates are deduplicated by ID, then passed along with the new facts to a second LLM call -- the update-decision call -- which uses tool/function-calling to return an array of actions. Each action carries an `event` field: `ADD` (insert a new memory), `UPDATE` (rewrite an existing one, referenced by `id`), `DELETE` (remove an existing one), or `NONE` (no change needed). The system then executes these actions against the vector store and records each change in the history database.

When `infer=False`, the LLM is bypassed entirely. Each message is stored verbatim as its own memory record -- one per non-system message -- with `actor_id` and `role` captured from the message metadata. This is a direct-storage mode with no extraction, deduplication, or conflict resolution.

The optional graph layer adds a knowledge-graph dimension. When a graph store is configured, `add()` runs vector and graph writes in parallel via `ThreadPoolExecutor`. The graph path makes three additional LLM calls: entity extraction (identifying entities in the text via the `EXTRACT_ENTITIES_TOOL`), relation extraction (determining relationships between entities via the `RELATIONS_TOOL`), and conflict resolution (comparing new relations against existing graph edges via `DELETE_MEMORY_TOOL_GRAPH`). Entities and relations are stored as nodes and edges in the graph database (Neo4j by default) with embeddings on each node. The graph uses `MERGE` operations with `ON CREATE SET` / `ON MATCH SET` clauses, incrementing a `mentions` counter on matched nodes. Conflicting relations are soft-deleted: the `valid` flag is set to `false` and an `invalidated_at` timestamp is recorded, preserving historical state.

In total, a single `add()` call with `infer=True` and graph enabled makes at minimum five LLM calls: fact extraction, update decision, entity extraction, relation extraction, and conflict resolution. Without the graph layer, it makes two LLM calls. With `infer=False`, it makes zero.

### Search and retrieval

The `search()` method accepts a query string plus optional `user_id`, `agent_id`, `run_id`, custom `filters`, a `threshold`, and a `rerank` flag (default `True`). Filters support a rich operator set: comparison operators (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `contains`, `icontains`) and logical combinators (`AND`, `OR`, `NOT`), processed by `_process_metadata_filters()` before being passed to the vector store.

The query is embedded and dispatched to the vector store. If a graph store is configured, graph search runs concurrently. The graph search path re-uses the entity extraction LLM call to identify entities in the query, then searches the graph database using cosine similarity on node embeddings (threshold default 0.7) and traverses outbound and inbound edges where `valid IS NULL OR valid = true`. Graph results are re-ranked internally using BM25 (`rank-bm25` library).

Vector search results can be re-ranked if a reranker is configured and `rerank=True`. The system catches reranking errors gracefully and falls back to the original ordering. When graph is enabled, the response includes both a `results` array (vector matches) and a `relations` array (graph edges). When it is not, only `results` is returned.

There is no composite scoring formula combining recency, verification status, or other signals. Relevance is purely vector similarity (plus optional reranker adjustment). There is no built-in recency decay, no verification boost, and no staleness detection in search scoring.

### LLM integration

LLM calls are deeply embedded in the write and search paths. The fact-extraction prompt, update-decision prompt, entity-extraction prompt, relation-extraction prompt, and conflict-resolution prompt are all defined in `mem0/configs/prompts.py` and `mem0/graphs/tools.py`. The update-decision step uses function/tool-calling, requiring an LLM provider that supports that capability.

The LLM provider is selected via configuration. The codebase ships 16+ provider implementations in `mem0/llms/`: OpenAI (standard and structured), Anthropic, Azure OpenAI (standard and structured), AWS Bedrock, Google Gemini, Groq, DeepSeek, Together, Ollama, LM Studio, vLLM, LiteLLM, LangChain, Minimax, Sarvam, and xAI. Each implements a common base interface from `mem0/llms/base.py`.

Embedding providers are similarly pluggable, with 11 implementations in `mem0/embeddings/`: OpenAI, Azure OpenAI, AWS Bedrock, Google Gemini, Google Vertex AI, HuggingFace, FastEmbed, Ollama, LM Studio, Together, LangChain, plus a mock provider for testing.

Reranking is optional and provided by five implementations in `mem0/reranker/`: Cohere, HuggingFace, sentence-transformers, an LLM-based reranker, and a "zero-entropy" reranker. The LLM-based reranker adds yet another LLM call to the search path.

The core dependency on `openai>=1.90.0` in `pyproject.toml` means OpenAI is the implicit default, though other providers can be configured.

### Deployment and operations

**Minimal self-hosted deployment** requires: a vector store (Qdrant is the default, declared as a core dependency via `qdrant-client>=1.9.1`), an LLM provider (for `infer=True` writes), and an embedding provider. With the defaults, this means a Qdrant instance and OpenAI API access. History is stored in SQLite via `mem0/memory/storage.py` -- a `SQLiteManager` class that uses `sqlite3.connect()` with a configurable path (defaulting to `:memory:`, meaning history is lost on restart unless a file path is provided). The SQLite backend is not pluggable; it is hardcoded with no abstraction layer.

**The `server/` directory** provides a FastAPI REST API. The `docker-compose.yaml` in that directory defines three services: the mem0 application (port 8888), PostgreSQL with pgvector (v0.5.1), and Neo4j 5.26.4 (with APOC plugin). PostgreSQL has a health check (`pg_isready`); Neo4j has a wget-based health check with a 90-second startup delay. The application container itself has no health check defined. Authentication is via a single `X-API-Key` header validated against an `ADMIN_API_KEY` environment variable using constant-time comparison.

**The `openmemory/` directory** is a separate, more full-featured deployment. It includes a FastAPI backend with its own database (using Alembic for migrations), a React frontend on port 3000, and an MCP server on port 8765. The `openmemory/compose/` directory provides Docker Compose fragments for nine different vector stores (Qdrant, pgvector, Chroma, Elasticsearch, FAISS, Milvus, OpenSearch, Redis, Weaviate), letting operators pick their backend. OpenMemory adds access logging, app-level ACLs, and a web UI for memory management.

There is no built-in health check endpoint in the core FastAPI server (`server/main.py`). Monitoring would need to be added externally.

### Multi-user support

Scoping in mem0 is based on three optional identifiers: `user_id`, `agent_id`, and `run_id`. At least one must be provided for any `add()` or `search()` call. These identifiers are stored as payload fields in the vector store and used as equality filters during search. There is no hierarchical relationship between them -- they are independent filter dimensions. A memory created with `user_id="alice"` is found by searching with `user_id="alice"`, but there is no concept of a workspace that groups users, no project-level isolation, and no cross-scope visibility rules.

The core library has no authentication or authorization. The `user_id` is a parameter passed by the caller, trusted as-is. The `server/` REST API adds a single shared API key (`ADMIN_API_KEY`), not per-user authentication.

OpenMemory adds a richer model. It introduces app-level ACLs (allow/deny rules controlling which apps can access which memories), access logging (every search and retrieval is recorded), and per-user memory ownership. But this is in the OpenMemory layer, not in the core `mem0` library. The core library's scoping remains flat: filter by `user_id`, `agent_id`, or `run_id`, with no enforcement of who can supply those values.

### Memory lifecycle

Deduplication and conflict resolution happen during the LLM-driven `add()` path. After extracting facts, the system searches for similar existing memories and asks the LLM to decide: add, update, delete, or do nothing. This means deduplication quality depends entirely on the LLM's judgment. There is no cosine-similarity threshold check -- the LLM sees the old memories and new facts and makes a free-form decision. When the LLM chooses `UPDATE`, the old memory text is replaced and recorded in history. When it chooses `DELETE`, the memory is removed and recorded with `is_deleted=1`.

History is tracked in the SQLite `history` table: each row records `memory_id`, `old_memory`, `new_memory`, `event`, timestamps, `actor_id`, `role`, and `is_deleted`. A `get_history()` method on the `Memory` class returns the change log for a given memory. However, this is an append-only audit log, not a versioning system -- there is no optimistic locking, no version numbers, and no way to roll back.

The core library has no concept of verification, staleness, or archival. Memories exist until they are deleted (hard delete from the vector store, soft-flagged in history). There is no `verified_at`, no staleness threshold, and no archive-without-delete.

OpenMemory extends this with a state machine. The `openmemory/api/` layer adds memory states: `active`, `archived`, `paused`, and `deleted`, tracked via `MemoryState` enum and `MemoryStatusHistory` records. It also adds categories for organizational grouping and an access log for audit trails. These features exist only in the OpenMemory web application, not in the core library or the basic `server/` REST API.

### Collaboration

The core library has no collaboration features. There is no comment system, no team activity feed, no "what changed since my last session" query, and no multi-user awareness. Each `user_id` operates in isolation. The `agent_id` dimension allows distinguishing memories written by different agents, and `run_id` scopes to a specific execution, but there is no mechanism for users or agents to annotate, discuss, or collectively curate memories.

OpenMemory's access logging and app-level ACLs provide some multi-agent coordination -- you can see which apps accessed which memories -- but this is observability, not collaboration. There is no equivalent of agent-brain's comment threads, team activity detection, or session-start context bootstrapping.

### Extensibility

Extensibility is mem0's strongest dimension. The backend pluggability is comprehensive:

**Vector stores:** 25+ implementations in `mem0/vector_stores/`, each implementing an 11-method abstract base class (`VectorStoreBase`): `create_col`, `insert`, `search`, `get`, `update`, `delete`, `list`, `list_cols`, `delete_col`, `col_info`, and `reset`. Supported backends include Qdrant, pgvector, Chroma, Pinecone, Milvus, Weaviate, Redis, Elasticsearch, OpenSearch, FAISS, MongoDB, Cassandra, Azure AI Search, Supabase, Upstash, Valkey, Databricks, S3 Vectors, Neptune Analytics, Turbopuffer, Vertex AI Vector Search, and more.

**Graph stores:** 5 implementations -- Neo4j, Memgraph, AWS Neptune, Kuzu (embedded), and Apache AGE (PostgreSQL extension).

**LLM providers:** 16+ implementations covering all major commercial and open-source providers.

**Embedding providers:** 11+ implementations including local options (Ollama, HuggingFace, FastEmbed, LM Studio).

**Rerankers:** 5 implementations spanning API-based (Cohere), local model-based (HuggingFace, sentence-transformers), and LLM-based approaches.

Custom prompts can be passed to `add()` via the `prompt` parameter, overriding the default fact-extraction prompt. The update-decision prompt (`DEFAULT_UPDATE_MEMORY_PROMPT`) and graph prompts are defined in source files and can be modified by forking, though there is no runtime configuration mechanism for those beyond the extraction prompt.

Configuration is dict-based: `Memory.from_config(config_dict)` accepts a dictionary specifying the vector store, LLM, embedder, graph store, and their respective connection parameters. This makes it straightforward to swap backends without code changes.

### Community

As of April 2026, the repository has approximately 51,700 stars, 5,800 forks, and 87 contributors (per the GitHub API). The license is Apache-2.0. The most recent release at time of research was v1.0.10 (April 1, 2025), with releases shipping roughly every 5-10 days through early 2025 (v1.0.3 through v1.0.10 between February and April 2025). The project also maintains a CLI tool versioned separately. The issue tracker shows 231 open issues with 2,778 closed pull requests, indicating active maintenance.

The project is backed by a company (Mem0.ai) that also operates a managed cloud platform. The open-source library serves as the foundation for both the self-hosted and cloud offerings. This dual model means the project has commercial incentives for continued development, but also introduces the risk that features may be prioritized for the cloud platform over the self-hosted path.

### Maintenance surface

The core dependency list is moderate: `qdrant-client`, `pydantic`, `openai`, `posthog`, `pytz`, `sqlalchemy`, and `protobuf` are required. The `openai` dependency is always installed even when using a different LLM provider. `posthog` is a telemetry client that phones home usage data (the code redacts sensitive config fields before capture). `sqlalchemy` is required for the history storage layer despite using raw `sqlite3` -- it is used in the OpenMemory layer.

Optional dependency groups are large. The `vector_stores` extra pulls in clients for 20+ databases. The `graph` extra brings in LangChain packages, Neo4j drivers, and the `rank-bm25` library. The `llms` extra adds provider-specific SDKs. A fully-featured installation with graph and multiple backends would have a substantial transitive dependency tree.

The codebase is significantly larger than agent-brain. The `mem0/` Python package alone spans dozens of modules across memory management, vector stores, graphs, LLMs, embeddings, rerankers, and configuration. The `server/` and `openmemory/` directories add two separate deployment surfaces. Schema evolution in the core uses SQLite with manual migration code in `storage.py`; OpenMemory uses Alembic.

What you depend on is substantial: the LLM provider for every inferred write (latency, cost, correctness of extraction), the vector store for all persistence, optionally a graph database, and the mem0 library itself as an upstream whose release cadence and priorities you do not control. What you own is the configuration and any customizations you build on top. The library absorbs significant complexity -- backend abstraction, prompt engineering, LLM orchestration -- but that complexity is not eliminated, just relocated. When the LLM misclassifies a fact, when the update-decision prompt produces an incorrect `DELETE`, or when a vector store adapter has a bug, debugging requires understanding the full pipeline across multiple abstraction layers.

## Gap Analysis

The two deep dives reveal systems built around different philosophies. Agent-brain is a deterministic store where the caller controls what goes in and a composite scoring function controls what comes out. Mem0 is an LLM-mediated layer that interprets, distills, and manages memories on the caller's behalf. The gaps between them follow from that core difference. What matters is whether each gap represents a real problem for the agent memory use case: AI coding assistants storing long-term context via MCP.

### Graph memory

Mem0 offers an optional knowledge graph built on Neo4j (or four other graph stores). When enabled, entity and relation extraction runs alongside vector storage, producing a network of nodes and edges that can be traversed during search. Agent-brain has no graph layer at all -- memories are flat rows in PostgreSQL with no inter-memory links.

The question is whether entity-relationship extraction solves a retrieval problem that vector search alone cannot. In the agent memory use case, the stored content is typically decisions, patterns, architectural notes, and project conventions -- not conversational transcripts about people, places, and events where entity graphs shine. A memory like "we use pnpm workspaces with strict hoisting" does not benefit from entity extraction; the text itself is the useful unit, and vector similarity finds it reliably from natural-language queries.

Graph memory also comes at substantial cost. Mem0's graph path adds three LLM calls per write (entity extraction, relation extraction, conflict resolution), requires a separate graph database in production, and introduces a second retrieval pathway that must be merged with vector results. For a solo-maintained deployment, this means another service to operate, another failure mode to debug, and ongoing LLM costs on every write.

This gap matters little in practice. The agent memory use case stores self-contained knowledge fragments, not interconnected entity networks. The complexity and operational cost of a graph layer are disproportionate to the retrieval benefit it would provide. If inter-memory relationships ever become important, lightweight approaches (tags, explicit cross-references in content, or a simple junction table) could address the need without a full graph database.

### LLM-driven extraction

Mem0's default write path sends user input through a fact-extraction prompt, producing distilled facts from conversational context. This is powerful when the input is a sprawling conversation and the desired output is atomic, reusable knowledge. Agent-brain stores exactly what the caller provides, with no interpretation or transformation.

The tradeoff is intelligence versus control. LLM extraction can surface implicit facts that a user might not think to save explicitly. But it also introduces unpredictability: the extraction prompt might miss important nuance, hallucinate a fact that was not stated, or split a coherent thought into fragments that lose context. Mem0's deep dive notes that when the LLM misclassifies a fact or produces an incorrect DELETE, debugging requires understanding the full pipeline across multiple abstraction layers.

For agent memory via MCP, the caller is itself an AI coding assistant that can formulate clean, structured memory content before calling `memory_create`. The input is not raw conversation -- it is already a distilled observation that the agent decided was worth saving. Running a second LLM pass over that input adds latency (two LLM calls minimum per write), cost, and a layer of indirection where the stored content may diverge from what was intended. Mem0 does offer `infer=False` to bypass extraction, but that mode loses deduplication and conflict resolution -- the features that make the LLM path valuable.

This gap is real but cuts both ways. LLM extraction would be valuable if agent-brain needed to ingest raw session transcripts. For the current use case, where the MCP client already curates what to store, deterministic storage with cosine-similarity dedup provides adequate quality with better predictability and no per-write LLM cost. The extraction capability is worth watching if the use case evolves toward automatic session summarization.

### Memory lifecycle

Agent-brain has explicit lifecycle machinery: `verified_at` timestamps, a staleness threshold (default 30 days), the `memory_list_stale` tool for maintenance triage, write budgets per session to prevent autonomous agents from flooding the store, and soft archival that nulls embeddings while preserving the record. Mem0 has LLM-driven deduplication and conflict resolution during writes, plus a history table that records changes, but no verification, no staleness detection, no write budgets, and no archival distinct from deletion.

Mem0's approach assumes the LLM will handle lifecycle implicitly: when new information contradicts old information, the update-decision prompt should emit an UPDATE or DELETE action. This works for factual conflicts ("user's email changed") but does not address gradual staleness -- a memory that was accurate six months ago and is now silently outdated will not be flagged unless new, contradictory information happens to arrive.

Agent-brain's verification and staleness system directly addresses knowledge rot, which is a real problem in long-lived projects. Codebases evolve, architectural decisions get revisited, and conventions change. A memory that says "we deploy to ECS" is dangerous if the team moved to Kubernetes three months ago and nobody re-verified the memory. The 5% relevance boost for verified memories is small but creates a useful signal: unverified memories gradually sink in search rankings as fresher, verified content rises.

Write budgets are similarly practical. Without them, an enthusiastic autonomous agent can create dozens of low-value memories in a single session, diluting search quality. Mem0 has no equivalent constraint.

This gap matters significantly. Lifecycle management is not a nice-to-have for a memory system that persists across months of project work -- it is how you prevent the knowledge base from decaying into noise. Mem0 would need substantial custom work on top to match this capability.

### Team collaboration

Agent-brain has comment threads on memories, a no-self-comment rule that encourages cross-user review, team activity detection via `memory_list_recent` with `exclude_self`, and session-start bootstrapping that reports what changed since the user's last session. Mem0's core library has none of this. OpenMemory adds access logging and app-level ACLs, but these are observability features, not collaboration mechanisms.

In the agent memory use case, "team collaboration" typically means multiple developers (each with their own AI assistant) sharing a project knowledge base. When one developer's agent records a decision, other developers' agents should be able to discover it, and there should be a way to discuss or refine shared knowledge. Agent-brain's comment system and activity feed serve this directly. Mem0's flat scoping by `user_id` means memories are siloed unless all agents use the same user ID, which eliminates per-user privacy.

This gap matters for multi-developer projects but is irrelevant for solo use. Since agent-brain already serves multi-user scenarios and mem0 would require building collaboration features from scratch, this is a meaningful advantage for agent-brain in team settings.

### Backend ecosystem

Mem0 supports 25+ vector stores, 5 graph stores, 16+ LLM providers, 11+ embedding providers, and 5 rerankers. Agent-brain supports pgvector for storage and 3 embedding providers (Ollama, Amazon Titan, and a mock). The gap in backend flexibility is enormous.

But backend flexibility matters most when you need to integrate with existing infrastructure, operate at scale across multiple environments, or avoid vendor lock-in for a component you might need to swap. For a self-hosted, single-deployment memory server, the relevant question is: does pgvector do the job? PostgreSQL with pgvector is a well-maintained, widely deployed combination. It runs in a single container, uses standard SQL tooling for backup and monitoring, and handles the working set sizes typical of agent memory (thousands to tens of thousands of memories, not millions) without breaking a sweat. HNSW indexing provides sub-millisecond approximate nearest neighbor search at these scales.

The embedding provider gap is more relevant. Agent-brain's three providers cover local (Ollama), cloud (Titan), and testing (mock), but lack OpenAI, Cohere, and other popular options. Adding a new provider is straightforward (implement a three-method interface), but it is still work that mem0 has already done.

This gap matters minimally for the vector store dimension -- pgvector is sufficient and adding backend options would increase maintenance burden without solving a real problem. The embedding provider gap is a minor inconvenience that can be addressed incrementally as needed. The massive backend ecosystem is a strength of mem0 for general-purpose use but is largely surplus for a focused, self-hosted deployment.

### Search sophistication

Mem0 offers optional rerankers (five implementations including Cohere, HuggingFace, and an LLM-based reranker) and parallel vector-plus-graph search when the graph layer is enabled. Relevance is determined by vector similarity plus optional reranker adjustment. Agent-brain uses a composite scoring function that blends similarity (80%), recency decay (15%), and verification status (5%), with 3x over-fetching and application-layer re-ranking.

These represent fundamentally different retrieval philosophies. Mem0 treats search as a pure relevance problem: find the vectors closest to the query and optionally refine the ranking with a learned model. Agent-brain treats search as a relevance-plus-freshness problem: a slightly less similar memory that was verified last week should sometimes rank above a more similar memory that has not been touched in six months.

For agent memory, the recency and verification signals are genuinely useful. When an AI assistant asks "how do we deploy this service?", the answer from last month is more likely correct than the answer from last year, even if the older answer has marginally higher cosine similarity. Mem0's rerankers could learn similar signals from training data, but they do not incorporate domain-specific signals like verification status, and the LLM-based reranker adds another LLM call to every search.

This gap is roughly neutral. Mem0 has more options for pure-relevance ranking; agent-brain has domain-appropriate signals baked into its scoring. Neither approach is clearly superior -- they optimize for different things. A reranker could be added to agent-brain's pipeline if pure-relevance ranking ever proves insufficient, and the composite scoring function could be tuned without external dependencies.

### History and audit trail

Mem0 tracks full event history per memory in its SQLite history table: each change records the old value, new value, event type, actor, and timestamp. Agent-brain has a `version` integer for optimistic locking but no change history -- when a memory is updated, the previous content is overwritten.

Change history is valuable for understanding how knowledge evolved and for debugging incorrect updates. If an LLM-driven update rewrites a memory incorrectly, mem0's history lets you see what changed and recover the old value. Agent-brain has no such safety net; an incorrect update is destructive (though optimistic locking prevents concurrent overwrites).

However, mem0's history implementation has practical limitations. The default SQLite backend uses `:memory:` storage, meaning history is lost on restart unless explicitly configured with a file path. The storage layer is not pluggable -- it is hardcoded SQLite with no abstraction. For a production deployment, you would need to ensure the SQLite file is persisted and backed up, adding another stateful component.

This gap matters moderately. Change history is a genuinely useful feature that agent-brain lacks. The implementation cost of adding a history table to agent-brain's PostgreSQL schema would be modest (an append-only table recording memory_id, old_content, new_content, event, author, timestamp), and it would benefit from PostgreSQL's existing backup and reliability infrastructure rather than requiring a separate SQLite file. This is a feature worth porting rather than a reason to adopt mem0.

### MCP integration

Agent-brain is MCP-native. The server exposes tools directly over Streamable HTTP, and every feature -- from session start to memory search to batch archival -- is accessible as an MCP tool. The tool design includes capability booleans (`can_edit`, `can_archive`, `can_verify`, `can_comment`) so calling agents know what actions are available.

Mem0's MCP integration exists in the OpenMemory layer, which is a separate deployment with its own database, its own FastAPI backend, and a React frontend. The MCP server in OpenMemory runs on port 8765 alongside the web UI on port 3000 and Neo4j on its standard ports. This means getting MCP access to mem0 requires deploying the full OpenMemory stack, not just the core library.

For the agent memory use case, MCP is not optional -- it is the integration protocol. AI coding assistants (Claude, Copilot, Cursor) connect to memory via MCP tools. Agent-brain's architecture was designed around this from the start, with tool signatures, error handling, and response formats optimized for agent consumption. Mem0's core library is a Python API designed for direct programmatic use; the MCP layer is an afterthought bolted on via OpenMemory.

This gap matters substantially. Adopting mem0 for MCP-based agent memory means either deploying OpenMemory (with its additional services, database, and frontend) or building a custom MCP wrapper around the core library. Either path adds significant integration work and ongoing maintenance -- exactly the burden the decision is trying to minimize.

## Scenarios

### Use only mem0

Switching to mem0 means gaining LLM-driven extraction and the deepest backend ecosystem available in the memory-layer space. If the use case ever shifts toward ingesting raw session transcripts rather than curated observations, the extraction pipeline is already built and tested across thousands of deployments. The 25+ vector store backends and 16+ LLM provider integrations mean you would never need to write an adapter yourself. These are real engineering assets that took significant community effort to produce.

What you lose is everything agent-brain built around the assumption that memories are long-lived artifacts, not disposable cache entries. There is no verification, no staleness detection, no write budgets, no soft archival. Memories accumulate until the LLM's update-decision prompt happens to notice a conflict with incoming information, and memories that silently go stale -- the "we deploy to ECS" problem -- persist indefinitely with no mechanism to surface them for review. The comment system, team activity feed, and session-start bootstrapping disappear entirely. Multi-user collaboration reverts to flat user_id filtering with no workspace hierarchy, no cross-scope visibility rules, and no privacy enforcement beyond trusting the caller to pass the right identifier.

You would need to build or accept the absence of several things. Lifecycle management would need to be reimplemented from scratch -- verification timestamps, staleness queries, budget tracking -- either in a wrapper layer or as patches to the mem0 codebase. Collaboration features would need a ground-up implementation since neither the core library nor OpenMemory provides comment threads or team activity detection. MCP integration means deploying OpenMemory (adding Neo4j, a separate PostgreSQL database, a React frontend, and the OpenMemory FastAPI backend on top of the core mem0 stack) or writing a custom MCP server that wraps the Python library.

The operational reality as a solo maintainer is heavier than it appears. The minimal self-hosted deployment requires Qdrant (or another vector store) plus an LLM provider for every inferred write. If you want MCP, add the full OpenMemory stack. If you want graph memory, add Neo4j. Each additional service is another container to monitor, another backup to manage, another upgrade cycle to track. The LLM dependency on the write path means every memory creation incurs latency and cost, and extraction quality is a black box you cannot tune without modifying prompts in the mem0 source. When something goes wrong -- a fact is misextracted, a memory is incorrectly deleted by the update-decision prompt -- debugging requires tracing through the extraction pipeline, the dedup search, and the LLM's tool-calling response across multiple abstraction layers in a codebase you did not write. You are trading ownership of 3,700 lines of TypeScript for dependency on a substantially larger Python codebase whose priorities are set by a company building a managed cloud platform. The maintenance burden shifts from "I own everything and it is small" to "I own the configuration and must understand enough of the internals to debug failures in a system optimized for a different deployment model."

### Wrap mem0

The wrapper approach attempts to get the best of both: mem0's storage and retrieval engine underneath, agent-brain's lifecycle and collaboration features on top. In theory, each layer handles what it does best. Mem0 manages embeddings, vector storage, LLM-driven dedup, and the backend ecosystem. The wrapper adds verification timestamps, staleness detection, write budgets, comments, team activity, workspace scoping, and the MCP transport.

The integration surface is where this theory meets friction. Mem0's internal data model is a vector-store record with an MD5 hash, session identifiers, and optional metadata. Agent-brain's model is a PostgreSQL row with typed enums, version integers, embedding vectors, and a rich set of timestamps. The wrapper would need to maintain a parallel data store -- likely PostgreSQL -- to hold the fields that mem0 does not support: `verified_at`, `archived_at`, `version`, `scope`, `type`, `comment_count`, and the comments themselves. Every operation becomes a coordination problem: creating a memory means writing to both mem0 and the wrapper's database, searching means querying mem0 and enriching the results with wrapper metadata, and updating means keeping both stores consistent. There is no transactional boundary spanning mem0's vector store and the wrapper's PostgreSQL, so partial failures are possible and recovery logic is necessary.

The cross-language concern is not trivial. Agent-brain is TypeScript; mem0 is Python. The wrapper either calls mem0 as a subprocess or HTTP service (adding network latency and a second runtime to deploy and monitor), or it reimplements the mem0 integration in TypeScript (defeating the purpose of wrapping). The Python runtime brings its own dependency management, virtual environments, and version constraints. You are now operating two language ecosystems, two sets of dependencies, and two upgrade cycles.

The deeper question is whether wrapping actually reduces maintenance. You still own the lifecycle features, the collaboration system, the MCP transport, and the workspace scoping -- the same code you would maintain in agent-brain alone. On top of that, you now own the integration layer: the code that translates between mem0's data model and yours, the consistency logic for dual writes, and the error handling for a system whose failure modes span two runtimes. You also inherit mem0's maintenance surface as a dependency: when mem0 releases a breaking change to its API, when Qdrant updates its protocol, when the extraction prompts change behavior, you absorb that as wrapper maintenance rather than as direct code changes. The wrapper does not eliminate complexity; it redistributes it across a larger surface area with more moving parts. For a solo maintainer, the coordination cost likely exceeds the value of the borrowed functionality, especially since the most valuable borrowed piece -- LLM-driven extraction -- is the one the current MCP workflow does not need.

### Agent-brain only

Continuing with agent-brain means keeping a system that already works for its intended purpose and selectively incorporating ideas from mem0 where the gap analysis identified genuine value.

The strongest case for porting is the history and audit trail. The gap analysis rated this as moderately important, and the implementation is straightforward: an append-only `memory_history` table in PostgreSQL recording the memory ID, previous content, new content, event type, author, and timestamp. Every update and archive operation would insert a row before mutating the memory. This piggybacks on existing PostgreSQL infrastructure -- no new services, no new backup targets, no new failure modes. The effort is a schema migration, a repository method, and wiring it into the update and archive paths. A few days of work at most, with immediate value for debugging incorrect updates and understanding how knowledge evolved.

LLM-driven extraction is the most tempting feature to port but the least necessary. The current workflow has the AI coding assistant curate memory content before calling `memory_create`. The input is already distilled; a second LLM pass adds cost and unpredictability without a clear quality improvement. If the use case evolves toward ingesting raw session transcripts -- where extraction genuinely helps -- the extraction logic could be added as an optional preprocessor in the MCP tool layer without restructuring the storage engine. This is a feature to defer, not to build preemptively.

Graph memory is not worth porting. The gap analysis found it matters little for the agent memory use case, and the operational cost of a graph database is disproportionate to the benefit. If inter-memory relationships become important, lightweight alternatives (a junction table, explicit cross-references in content, or tag-based grouping) can be added within PostgreSQL.

The backend ecosystem gap -- 25+ vector stores versus pgvector alone -- is similarly not worth closing. Adding vector store backends increases the maintenance surface without solving a problem that exists. Pgvector handles the working set sizes of agent memory comfortably, runs inside the existing PostgreSQL instance, and requires no additional services. Embedding provider coverage is a minor gap worth closing incrementally: an OpenAI provider would take an afternoon to implement against the existing three-method interface, and would cover the most commonly requested alternative.

What you keep by staying on agent-brain is a system sized to its problem. The entire codebase is 3,700 lines of TypeScript with 10 production dependencies, a single PostgreSQL database, and a deployment that fits in two containers. Every behavior is visible in the source. The lifecycle machinery -- verification, staleness, write budgets, archival -- exists because the use case demands it, not because a framework provided it. The collaboration features work because they were designed for the specific multi-user model of AI coding assistants sharing project knowledge. The MCP integration is native, not bolted on.

The maintenance trade-off is clear: you own everything, which means every bug is yours to fix and every feature is yours to build. But "everything" is small and focused. There is no upstream whose priorities might diverge from yours, no LLM dependency on the write path whose costs and failure modes you must absorb, and no abstraction layers hiding behavior you need to understand. The risk is stagnation -- a solo maintainer has finite time, and features that mem0's community builds in parallel (new embedding providers, new retrieval strategies) must be built one at a time. The mitigation is that the feature surface is deliberately narrow, and the gap analysis confirms that most of mem0's breadth addresses problems that do not exist in the agent memory use case.

## Recommendation

Continue with agent-brain. Port the history/audit trail from mem0's design. Do not adopt mem0 or build a wrapper.

### Rationale

The gap analysis found two categories of differences: features where agent-brain leads and features where mem0 leads. The features where agent-brain leads -- lifecycle management, MCP integration, and collaboration -- are the ones that matter for this use case. The features where mem0 leads -- backend ecosystem, LLM-driven extraction, and graph memory -- are the ones that do not.

**Maintenance burden** is the deciding factor. Agent-brain is 3,700 lines of TypeScript with 10 production dependencies and a single PostgreSQL database. Every line is visible, every behavior is controllable, and the total surface area is small enough for a solo maintainer to hold in their head. Adopting mem0 replaces that with dependency on a larger Python codebase whose priorities are set by a company building a managed cloud platform. Wrapping mem0 makes it worse: you still own all of agent-brain's lifecycle and collaboration code, plus an integration layer coordinating two runtimes, two data stores, and two dependency ecosystems. Neither option reduces maintenance; both increase it.

**Operational complexity** favors agent-brain decisively. The current deployment is two containers: PostgreSQL with pgvector and the application. Mem0 with MCP access requires the OpenMemory stack (its own PostgreSQL, Neo4j, a React frontend, and a FastAPI backend) or a custom MCP wrapper. Every additional service is another container to monitor, back up, and upgrade. The LLM dependency on mem0's write path adds latency, cost, and a failure mode that does not exist in agent-brain's deterministic storage.

**Performance** is not a concern at current scale, but agent-brain's write path (one embedding call, one SQL insert) is inherently faster and cheaper than mem0's (two to five LLM calls plus vector store operations per write). This gap widens as memory volume grows.

**Extensibility** is mem0's strongest dimension, but the breadth is surplus. Pgvector handles agent memory workloads without strain. The 25+ vector store backends solve a problem that does not exist for a single self-hosted deployment. The embedding provider gap is real but minor -- adding an OpenAI provider against agent-brain's three-method interface is an afternoon of work, not a reason to adopt an entire framework.

**Community** is the one axis where mem0 has an unambiguous advantage: 87 contributors, frequent releases, and commercial backing versus a solo maintainer. The mitigation is that agent-brain's feature surface is deliberately narrow. The gap analysis confirmed that the features mem0's community builds in parallel -- more vector stores, more LLM providers, graph improvements -- address problems outside the agent memory use case. The stagnation risk is real but bounded by the scope of what needs to be built.

The single feature clearly worth porting is the **history and audit trail**. Mem0's approach of recording old value, new value, event type, actor, and timestamp per change is sound. The implementation in agent-brain is straightforward: an append-only PostgreSQL table, a repository method, and wiring into the update and archive code paths. This provides rollback capability and change visibility without introducing new services or dependencies.

### Next steps

1. **Add a `memory_history` table** to PostgreSQL. Schema: `id`, `memory_id`, `old_content`, `new_content`, `old_title`, `new_title`, `event` (created, updated, archived, unarchived), `author`, `created_at`. Insert a row on every update and archive operation. Expose via a `memory_history` MCP tool that returns the change log for a given memory ID.

2. **Add an OpenAI embedding provider.** Implement the three-method `EmbeddingProvider` interface against OpenAI's embedding API. This closes the most commonly relevant gap in provider coverage with minimal effort.

3. **Revisit this decision in six months.** The use case may evolve. If agent-brain starts ingesting raw session transcripts rather than curated observations, LLM-driven extraction becomes worth building. If multi-deployment or multi-region requirements emerge, backend flexibility becomes relevant. Neither is true today.
