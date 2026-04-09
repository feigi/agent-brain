# agent-brain vs LightRAG

## Introduction

This document evaluates whether [LightRAG](https://github.com/HKUDS/LightRAG) (a graph-enhanced RAG system from HKU Data Science Lab) could serve as a storage backend for [agent-brain](https://github.com/feigi/agent-brain) (a custom MCP memory server). Unlike the [mem0 comparison](./agent-brain-vs-mem0.md), which evaluated a system in the same problem space (agent memory), LightRAG operates in a different domain (document retrieval-augmented generation). This analysis examines whether its storage abstractions, knowledge graph capabilities, or retrieval engine could replace or augment agent-brain's storage layer.

The goal is to decide between three options:

1. **Use LightRAG as a backend** -- replace agent-brain's PostgreSQL/pgvector storage with LightRAG's storage engine.
2. **Use LightRAG alongside agent-brain** -- run both systems, using LightRAG for graph-augmented retrieval over agent-brain's memories.
3. **Continue with agent-brain only** -- keep the current architecture unchanged.

### Why now

LightRAG is a fast-growing open-source project (29K+ GitHub stars, EMNLP 2025 paper) that offers graph-enhanced retrieval with pluggable storage backends, including PostgreSQL. Since agent-brain already uses PostgreSQL with pgvector, there is a surface-level overlap worth investigating.

### Decision criteria

The criteria, in priority order:

1. **Architectural fit** -- Does LightRAG's data model and API surface align with agent-brain's storage requirements? This is the primary concern. A backend swap that requires extensive adaptation negates the benefit.
2. **Maintenance burden** -- How much ongoing work does each option require? A solo maintainer cannot absorb unbounded maintenance cost.
3. **Operational complexity** -- What does deployment, monitoring, and day-to-day operation look like?
4. **Performance** -- Latency and resource consumption for typical workloads (memory creation, search, retrieval).
5. **Community health** -- Contributor activity, issue response times, release cadence, bus factor.

### Out of scope

The following are explicitly excluded from this comparison:

- **Programming language choice** -- Not a deciding factor; both projects can be integrated regardless of language (TypeScript vs Python).
- **LightRAG as a general-purpose RAG tool** -- We evaluate only the backend-for-agent-brain use case, not LightRAG's quality as a document retrieval system.
- **LightRAG's WebUI and server features** -- Only the storage abstractions and retrieval engine are relevant.
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

Listing supports cursor-based pagination (fetching `limit + 1` to determine `has_more`), filtering by type and tags (via `arrayOverlaps`), and sorting by `created_at` or `updated_at` in either direction.

### LLM integration

The only AI/ML integration is vector embedding for semantic search. No generative LLM is called at any point. The embedding provider is behind a three-method interface (`embed`, `modelName`, `dimensions`) and is selected at startup via the `EMBEDDING_PROVIDER` environment variable.

Three providers ship with the codebase: **Ollama** (local, default `nomic-embed-text`, 768 dimensions), **Amazon Titan** (`amazon.titan-embed-text-v2:0` via AWS Bedrock, supporting 256/512/1024 dimensions), and **Mock** (deterministic vectors for testing). Adding a new provider means implementing one interface and adding one case to the factory.

### Deployment and operations

The server runs as a Node.js process (Node 22, TypeScript via tsx) exposing a stateless MCP endpoint over Streamable HTTP on `/mcp`. Infrastructure requires PostgreSQL with pgvector and an embedding provider. The `docker-compose.yml` defines PostgreSQL 17 (pgvector image) and Ollama. The production deployment fits in two containers. Database migrations run automatically on startup via Drizzle Kit.

### Multi-user support

Tenancy is structured as deployment > project > workspace > user. The `project_id` is set at server startup and hard-codes deployment-level isolation. Within a project, workspaces are auto-created on first use. The three scopes control visibility: **workspace** (shared), **user** (private to author), and **project** (spans all workspaces). There is no authentication layer; the `user_id` is trusted as passed by the MCP client.

### Memory lifecycle

Memories have verification timestamps (`verified_at`, `verified_by`), staleness detection (configurable threshold, default 30 days), write budgets per session (default 10, tracked atomically), semantic duplicate detection, soft archival (nulls embedding, preserves record), and optimistic locking via a `version` field with atomic `WHERE version = expected` guards.

### Collaboration

Comment threads on memories (append-only, no-self-comment rule), team activity detection via `memory_list_recent` with `exclude_self`, session-start bootstrapping that reports what changed since the user's last session, and capability booleans (`can_edit`, `can_archive`, `can_verify`, `can_comment`) on every memory response.

### Extensibility

The embedding provider interface is the primary extension point. The `metadata` JSONB column is schemaless. The server exposes both MCP tools and REST routes. The database layer uses Drizzle ORM with typed schemas and generated migrations.

### Community

Solo-maintainer project with approximately 260 commits. No external contributors, no published release cadence. Purpose-built for the AI coding assistant memory use case via MCP.

### Maintenance surface

10 production dependencies, approximately 3,700 lines of TypeScript across 41 files. Layered architecture: tools → services → repositories → Drizzle → PostgreSQL. No ORM magic, no dependency injection framework, no runtime code generation. Total control, total ownership.

## LightRAG

### Core model

LightRAG is a document retrieval system, not a discrete memory store. The fundamental unit of input is a **document** (arbitrary-length text), not a structured record. When a document is inserted via `ainsert()`, LightRAG performs a multi-stage pipeline:

1. **Chunking**: The document is split into `TextChunkSchema` objects, each carrying `tokens` (token count), `content` (text), `full_doc_id` (source document ID), and `chunk_order_index` (position). Chunk IDs are MD5-based with a `chunk-` prefix. _(Source: `lightrag/lightrag.py`, lines 1313-1330)_

2. **Entity/relation extraction**: Each chunk is sent to a configured LLM, which extracts named entities (`KnowledgeGraphNode`: `id`, `labels[]`, `properties{}`) and relationships (`KnowledgeGraphEdge`: `id`, `type`, `source`, `target`, `properties{}`). This is not optional -- every `ainsert()` call requires LLM access. _(Source: `lightrag/base.py`, `KnowledgeGraphNode` and `KnowledgeGraphEdge` classes; `lightrag/operate.py` for extraction logic)_

3. **Storage**: Results are persisted across four parallel storage systems:
   - **KV store**: Raw chunks, entity descriptions, relation descriptions (key-value lookup)
   - **Vector store**: Embeddings for chunks, entities, and relations (three separate vector indexes)
   - **Graph store**: Entity nodes and relationship edges (bidirectional, undirected)
   - **Doc status store**: Document processing lifecycle (pending → processing → preprocessed → processed/failed)

There is no concept of a discrete "memory" with typed fields, scoping, versioning, or metadata beyond what the extraction pipeline produces. What you store is what the LLM extracted, not what you wrote. The input text is chunked and its meaning is decomposed into a knowledge graph -- the original document's structure and semantics are transformed, not preserved.

### Search and retrieval

LightRAG offers six query modes, verified from `base.py`'s `QueryParam.mode` field:

| Mode     | Behavior                                                      | Use case                            |
| -------- | ------------------------------------------------------------- | ----------------------------------- |
| `local`  | Finds relevant entities, traverses their direct relationships | Context-dependent factual questions |
| `global` | Searches relationships directly                               | Broad knowledge questions           |
| `hybrid` | Combines local + global results                               | Complex questions needing both      |
| `naive`  | Pure vector search on chunks (no graph)                       | Simple semantic similarity          |
| `mix`    | KG retrieval + vector search with reranking                   | Balanced (default)                  |
| `bypass` | Returns raw vector results without LLM generation             | Debugging                           |

The `mix` mode is the default and recommended mode. It combines knowledge graph traversal with vector similarity search and applies reranking. The cosine similarity threshold is `0.2` by default (compared to agent-brain's `0.3`).

Search returns a `QueryResult` object containing: `content` (LLM-generated response), `response_iterator` (streaming), `raw_data` (structured results), and `reference_list` (citations with file paths). Note that most query modes involve an LLM call to generate a response from retrieved context -- search is not a pure retrieval operation but a retrieval-then-generate pipeline.

The `aquery_data()` method provides structured results without LLM generation, returning entities, relations, and source chunks. This is the closest equivalent to a retrieval-only search.

### LLM integration

LLM calls are mandatory and deeply embedded. Every document insertion requires LLM calls for entity and relation extraction. The README recommends an LLM with at least 32 billion parameters and 32KB+ context length for accurate extraction. Most query modes also require an LLM call to generate a response from retrieved context.

There is no `infer=False` equivalent. Unlike mem0, which can bypass LLM processing, LightRAG's core value proposition _is_ the LLM-driven extraction pipeline. Inserting a document without extraction would just be storing raw text chunks without building the knowledge graph -- defeating the purpose of using LightRAG.

Embedding providers are pluggable. The README mentions OpenAI, Ollama, HuggingFace, and others. A reranker is supported (e.g., `BAAI/bge-reranker-v2-m3`), enabled by default in `mix` query mode.

### Deployment and operations

**Minimal deployment** requires: a working directory for storage files (JSON-based KV and vector stores by default), an LLM provider, and an embedding provider. The defaults use file-based storage (JSON files + NanoVectorDB), making initial setup simple but unsuitable for production.

**Production deployment** options include:

- PostgreSQL for all four storage layers (`PGKVStorage`, `PGVectorStorage`, `PGGraphStorage`, `PGDocStatusStorage`) -- verified in source at `lightrag/kg/postgres_impl.py`
- MongoDB, Neo4j, Milvus, Qdrant, OpenSearch, and others as alternatives
- Docker Compose with environment configuration via `.env` file
- An interactive setup wizard (`make env-base`, `make env-storage`, etc.)

The LightRAG Server provides a WebUI (built with Bun) and a REST API with 16 document endpoints and 3 query endpoints. The server is designed around Uvicorn (single-process) or Gunicorn (multi-process) with shared memory coordination.

**Infrastructure is heavier than agent-brain**: at minimum an LLM provider (not just an embedding model), and for production use, a database backend. The PostgreSQL option consolidates storage but still requires LLM access for every write.

### Multi-user support

LightRAG has **no multi-user support**. There is no concept of users, workspaces, scoping, or access control anywhere in the codebase. The entire system operates as a single knowledge base. All documents and their extracted entities/relations are visible to all queries. There is no `user_id`, no `workspace_id`, no scope filtering.

The `working_dir` parameter provides file-system-level isolation (different directories = different knowledge bases), but this is not user-level scoping -- it is instance-level isolation requiring separate LightRAG instances.

### Memory lifecycle

LightRAG has no memory lifecycle management:

- **No verification**: No `verified_at`, no staleness detection, no mechanism to mark knowledge as confirmed or outdated.
- **No write budgets**: No limit on autonomous writes. Any caller can insert unlimited documents.
- **No duplicate detection**: Documents are re-chunked and re-extracted on every insert. Duplicate chunks or entities may be created from similar documents. Entity dedup happens only at the graph level via `MERGE` operations on node names.
- **No archival**: There is no soft delete. Documents can be hard-deleted via `adelete_by_doc_id()`, which cascades to chunks, entities, and relations. Deleted data is not recoverable.
- **No versioning**: No optimistic locking, no version field, no concurrent write protection.
- **No update API**: There is no method to update a document or entity in place. Changes require deleting and re-inserting, which triggers full re-extraction via LLM. _(Verified: the `LightRAG` class has no `update()` or `aupdate()` method.)_

### Collaboration

LightRAG has **no collaboration features**. No comments, no team activity feed, no session tracking, no multi-user awareness. It is a single-user document retrieval system.

### Extensibility

Extensibility is LightRAG's strongest dimension, particularly in storage backends.

**Four storage abstraction layers**, each with multiple implementations:

| Layer              | Interface                                                                  | Implementations                                                                         |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **KV storage**     | `BaseKVStorage` (get_by_id, upsert, delete)                                | JSON (default), Redis, PostgreSQL, MongoDB, OpenSearch                                  |
| **Vector storage** | `BaseVectorStorage` (query, upsert, delete)                                | NanoVectorDB (default), Milvus, PostgreSQL pgvector, Faiss, Qdrant, MongoDB, OpenSearch |
| **Graph storage**  | `BaseGraphStorage` (upsert_node, upsert_edge, get_node, delete_node, etc.) | NetworkX (default), Neo4j, PostgreSQL, MongoDB, Memgraph, OpenSearch                    |
| **Doc status**     | `DocStatusStorage` (track document processing state)                       | JSON (default), Redis, PostgreSQL, MongoDB, OpenSearch                                  |

PostgreSQL can serve as a unified backend for all four layers, which is relevant since agent-brain already uses PostgreSQL. However, this is PostgreSQL-as-storage-engine, not PostgreSQL-as-schema -- LightRAG's PostgreSQL tables have a completely different schema than agent-brain's.

Custom chunking strategies and extraction prompts are configurable. The reranker is pluggable.

### Community

As of April 2026, the repository has approximately 29,000 stars and active development. The project has an associated academic paper (EMNLP 2025). The license is MIT. The team has released companion projects: MiniRAG (small-model RAG), VideoRAG (video understanding), and RAG-Anything (multimodal document processing). There is a Discord community and active issue tracker.

The project is research-lab-driven (HKU Data Science Lab), not company-backed. This means development is likely tied to academic incentives (publication cycles, student contributions) rather than commercial product roadmaps.

### Maintenance surface

The Python codebase is significantly larger than agent-brain. The `lightrag/` package spans dozens of modules across storage, extraction, graph operations, API routes, and configuration. The dependency tree includes LLM provider SDKs, vector database clients, graph database drivers, and NLP libraries.

The LLM dependency on the write path means every document insertion incurs latency, cost, and a dependency on LLM availability. When extraction quality degrades (incorrect entities, missed relations), debugging requires understanding the extraction prompts and the LLM's behavior -- a fundamentally different kind of maintenance than fixing SQL queries.

## Gap Analysis

### Data model compatibility

This is the decisive gap. The data models are fundamentally incompatible:

| Dimension        | agent-brain `Memory`                                                                            | LightRAG stored items                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary unit** | Discrete record (single fact, decision, learning)                                               | Document chunks + KG entities + KG relations                                                                                                      |
| **Fields**       | 20+ typed fields (type, scope, tags, version, verified_at, archived_at, author, metadata, etc.) | Chunk: 4 fields (tokens, content, full_doc_id, chunk_order_index). Entity: id, labels, properties. Relation: id, type, source, target, properties |
| **Identity**     | nanoid, human-meaningful title                                                                  | MD5-based chunk IDs, entity name as ID                                                                                                            |
| **Typing**       | 6-value enum (fact, decision, learning, pattern, preference, architecture)                      | No type system                                                                                                                                    |
| **Scoping**      | 3-level hierarchy (project > workspace > user) with visibility rules                            | None                                                                                                                                              |
| **Versioning**   | Optimistic locking via `version` integer                                                        | None                                                                                                                                              |
| **Lifecycle**    | verified_at, archived_at, staleness detection                                                   | None                                                                                                                                              |
| **Authorship**   | `author` field with access control                                                              | None                                                                                                                                              |

Agent-brain stores what the user wrote, exactly as written. LightRAG transforms input through an LLM extraction pipeline, decomposing it into entities and relations. These are not two representations of the same data -- they are two different data models for two different purposes.

To use LightRAG as a backend, agent-brain would need to either:

1. Store memories as "documents" and rely on LightRAG's extraction to decompose them -- losing the exact content, the type system, the scoping, the versioning, and all lifecycle fields.
2. Use LightRAG's KV storage (`BaseKVStorage`) as a dumb key-value store -- bypassing the entire knowledge graph, which is LightRAG's reason to exist.

Neither option makes architectural sense.

### Storage abstraction alignment

Agent-brain's storage layer is a repository pattern with a rich `MemoryRepository` interface:

```
create(), findById(), update(), archive(), search(), list(),
findStale(), findDuplicates(), findPairwiseSimilar(),
listWithEmbeddings(), verify(), countTeamActivity()
```

LightRAG's storage abstractions are:

```
BaseKVStorage: get_by_id(), upsert(), delete()
BaseVectorStorage: query(), upsert(), delete(), get_by_id()
BaseGraphStorage: upsert_node(), upsert_edge(), get_node(), delete_node(), get_edge(), delete_edge()
```

The overlap is minimal. Agent-brain needs `findStale()` (query by `verified_at` threshold), `findDuplicates()` (cosine similarity search against existing memories in the same scope), `findPairwiseSimilar()` (CROSS JOIN for consolidation), `countTeamActivity()` (aggregate counts by timestamp ranges), and `archive()` (soft delete with embedding nullification). None of these exist in LightRAG's storage interfaces. Implementing them would mean building a custom storage layer on top of LightRAG -- at which point you are not using LightRAG as a backend, you are using PostgreSQL with extra steps.

### Graph-augmented retrieval

This is the one area where LightRAG offers genuine value that agent-brain lacks. LightRAG's knowledge graph enables:

- **Entity-relationship retrieval**: "What decisions relate to the authentication system?" could traverse entity→relation→entity paths to find connected memories.
- **Multi-mode querying**: Local (entity-focused), global (relation-focused), and hybrid modes provide different retrieval strategies for different question types.
- **Structural context**: The graph captures _how_ concepts relate, not just _that_ they are semantically similar.

However, the value depends on whether agent-brain's memories benefit from graph structure. Agent-brain stores discrete, independent memories -- each is a self-contained fact, decision, or learning. The relationships between memories are implicit (semantic similarity via embeddings) rather than explicit (entity-relationship links). For the typical query pattern ("What do we know about deploying service X?"), cosine similarity with recency decay already provides relevant results without graph traversal.

Graph-augmented retrieval would be most valuable if agent-brain supported complex queries like "What decisions were influenced by the learning that database migrations are slow?" -- multi-hop reasoning across memory relationships. But this requires (a) explicit relationship extraction via LLM (adding cost and complexity to every write), (b) a graph database (adding infrastructure), and (c) query modes that agent-brain's MCP tools do not currently expose.

### LLM dependency

Agent-brain has zero LLM cost at runtime. Every write is one embedding call (a vector-only operation, not a generative model call) and one SQL insert. The cost per memory creation is effectively zero beyond the embedding computation.

LightRAG requires LLM calls for every document insertion. The extraction pipeline sends each chunk to the LLM for entity and relation identification. The README recommends models with ≥32B parameters and ≥32KB context for quality extraction. For a memory backend handling frequent small writes (typical in agent-brain's workflow -- dozens of memories per session), this means:

- **Latency**: Each memory creation would wait for LLM inference (seconds, not milliseconds).
- **Cost**: Every write incurs LLM API charges (or requires a locally hosted ≥32B model).
- **Reliability**: LLM unavailability blocks all writes, not just search.
- **Unpredictability**: Extraction quality varies with LLM behavior, prompt sensitivity, and input format. The same input may produce different entities on different runs.

This is a fundamental architectural mismatch. Agent-brain's deterministic, embedding-only write path is a deliberate design choice that prioritizes predictability and cost-efficiency. Introducing mandatory LLM calls on the write path contradicts this design philosophy.

### Team collaboration

LightRAG has no collaboration features. No comments, no verification, no team activity, no session tracking, no multi-user awareness. Agent-brain's collaboration layer (comments, verification, staleness detection, activity feeds, capability booleans) has no LightRAG equivalent and cannot be built on top of LightRAG's storage abstractions because they lack the necessary fields (author, scope, verified_at, comment_count, etc.).

This gap is total. Using LightRAG as a backend would require rebuilding the entire collaboration layer from scratch -- the same code that already exists in agent-brain -- but now coordinating with a different storage engine.

### Backend ecosystem

LightRAG supports 16+ storage backends across four layers. Agent-brain supports PostgreSQL with pgvector. The gap in backend flexibility is real but, as established in the mem0 comparison, largely irrelevant for a single self-hosted deployment. Pgvector handles agent memory workloads (thousands to tens of thousands of memories) without strain.

The interesting overlap is that LightRAG's PostgreSQL implementation (`PGKVStorage`, `PGVectorStorage`, `PGGraphStorage`, `PGDocStatusStorage`) uses the same database technology as agent-brain. In theory, both could share a PostgreSQL instance. In practice, they would use entirely different schemas with no interaction -- two applications sharing a database server, not a backend.

### MCP integration

Agent-brain is MCP-native. Every feature is exposed as an MCP tool with structured input/output designed for AI agent consumption.

LightRAG has **no MCP support**. The codebase contains no MCP protocol implementation, no tool definitions, no resource handling, and no prompt capabilities. _(Verified by searching the entire repository for "mcp", "model context protocol", and "tool" -- no matches in the protocol context.)_ LightRAG exposes a REST API (FastAPI-based) and a Python SDK. Integrating LightRAG into an MCP workflow would require building a custom MCP wrapper around its REST API or Python SDK.

## Scenarios

### Use LightRAG as agent-brain backend

**Verdict: Not viable.**

The data models are incompatible. Agent-brain stores discrete, typed memories with 20+ fields. LightRAG stores document chunks and knowledge graph entities/relations. There is no mapping between these models that preserves agent-brain's functionality.

Attempting to use LightRAG's storage would mean:

1. **Losing the type system** -- LightRAG has no memory types (fact, decision, learning, etc.).
2. **Losing scoping** -- LightRAG has no user/workspace/project hierarchy.
3. **Losing lifecycle management** -- No verification, no staleness, no budgets, no archival.
4. **Losing collaboration** -- No comments, no team activity, no capability booleans.
5. **Losing versioning** -- No optimistic locking, no concurrent write protection.
6. **Adding mandatory LLM cost** -- Every memory creation would require LLM extraction.
7. **Losing deterministic storage** -- What you write is transformed by LLM extraction, not stored verbatim.

The only way to make this work would be to use LightRAG's `BaseKVStorage` as a dumb key-value store, bypassing the knowledge graph entirely. But then you are not using LightRAG -- you are using a key-value abstraction with more overhead than direct PostgreSQL access, and you still need to reimplement everything agent-brain already has (search, scoping, lifecycle, collaboration) on top of an interface that was not designed for it.

### Use LightRAG alongside agent-brain

**Verdict: Technically possible but high cost, low value at current scale.**

In this scenario, agent-brain continues to handle all memory CRUD, scoping, lifecycle, and collaboration. LightRAG runs as a separate system that periodically ingests agent-brain's memories, extracts a knowledge graph, and provides graph-augmented retrieval as a supplementary search mode.

**Architecture sketch:**

```
MCP Client → agent-brain MCP server (unchanged API)
                ├─ All existing features (CRUD, scoping, lifecycle, collaboration)
                ├─ Standard vector search (pgvector)
                └─ Optional: LightRAG graph search
                    ├─ Periodic sync: export memories → insert into LightRAG
                    ├─ Graph query: translate MCP query → LightRAG aquery_data()
                    └─ Merge results: combine pgvector + graph results
```

**Arguments for:**

- Gain entity-relationship retrieval ("what decisions relate to authentication?")
- LightRAG's `mix` mode could surface non-obvious connections between memories
- Could run on the same PostgreSQL instance (different schema)

**Arguments against:**

- **LLM cost on sync**: Every memory must be processed by an LLM during sync. For a knowledge base of ~500 memories, this is manageable. For frequent sync (on every write), it adds seconds of latency per memory.
- **Sync complexity**: Keeping LightRAG's knowledge graph consistent with agent-brain's memories requires a sync pipeline: detect new/updated/archived memories, insert/re-insert/delete in LightRAG, handle extraction failures. This is a new subsystem to build and maintain.
- **Infrastructure**: LightRAG requires an LLM provider (either API access or a locally hosted ≥32B model). This is a significant addition to agent-brain's current two-container deployment.
- **Cross-language bridge**: Agent-brain is TypeScript; LightRAG is Python. Integration requires either HTTP calls to LightRAG's REST API (adding a service to deploy) or a Python subprocess (adding a runtime dependency).
- **Marginal retrieval improvement**: Agent-brain's composite scoring (similarity + recency + verification) already provides relevant results for the typical query pattern. Graph-augmented retrieval would primarily help with relationship-based queries, which are not the dominant access pattern.
- **Maintenance burden**: You now maintain two systems, a sync pipeline, and a cross-language integration layer. When something goes wrong (stale graph, extraction errors, sync failures), debugging spans two codebases in two languages.

**Implementation effort:**

- Sync pipeline: ~500-800 LOC (TypeScript, periodic job, delta detection, error handling)
- LightRAG MCP tool wrapper: ~200 LOC (expose graph search as MCP tool)
- LightRAG deployment: 1 additional container + LLM provider configuration
- Operational overhead: LLM costs, sync monitoring, graph consistency checks

### Agent-brain only

**Verdict: Recommended.**

Agent-brain's current architecture is well-suited to its use case. The storage layer (PostgreSQL + pgvector) handles the working set sizes of agent memory comfortably. The composite scoring function (similarity + recency + verification) addresses the retrieval needs of AI coding assistants sharing project knowledge. The collaboration features, lifecycle management, and MCP integration were purpose-built for this workflow.

The features LightRAG offers that agent-brain lacks:

1. **Knowledge graph / entity-relationship retrieval** -- Genuine capability gap, but the use case does not demand it. Agent-brain's memories are discrete and self-contained; the relationships between them are adequately captured by semantic similarity. If inter-memory relationships become important, lightweight alternatives (a tags-based linking system, explicit `related_to` fields in metadata, or a simple junction table) can be added within PostgreSQL at a fraction of LightRAG's complexity.

2. **Multi-mode querying** -- LightRAG's six query modes offer flexibility, but agent-brain's single search path (embed → vector search → composite re-rank) is simpler and cheaper. The dominant query pattern is "find memories relevant to X" -- semantic similarity with recency bias handles this well.

3. **Backend flexibility** -- LightRAG's 16+ backends are impressive but unnecessary for a single PostgreSQL deployment that handles the current scale without strain.

What you keep by staying on agent-brain alone: a system sized to its problem, with 10 production dependencies, a single database, and a two-container deployment. No LLM cost on writes, no sync pipelines, no cross-language bridges, no graph database maintenance.

## Recommendation

Continue with agent-brain only. Do not adopt LightRAG as a backend or as a complementary system.

### Rationale

**The systems solve different problems.** LightRAG is a document retrieval system that ingests long texts, extracts knowledge graphs via LLM, and provides graph-augmented Q&A. Agent-brain is a discrete memory store for AI coding assistants, optimized for structured records with lifecycle management and team collaboration. Using LightRAG as a backend for agent-brain is like using a search engine as a database -- the abstraction layers do not align.

**Architectural fit** is the deciding factor, even before considering maintenance or operational complexity. Agent-brain's `MemoryRepository` interface requires 12+ specialized methods (find by scope, find duplicates, find stale, count team activity, etc.) that have no equivalent in LightRAG's storage abstractions. Implementing them on top of LightRAG would mean rebuilding agent-brain's repository layer from scratch, using LightRAG's storage only as an intermediate layer that adds complexity without value.

**The LLM dependency is a dealbreaker for the backend use case.** Agent-brain's zero-LLM-cost write path is a deliberate design choice. Adding mandatory LLM calls to every memory creation contradicts the project's architectural philosophy, increases cost, adds latency, and introduces an availability dependency that does not exist today.

**The complementary use case does not justify the cost** at current scale. Graph-augmented retrieval over agent-brain's memories would provide marginal improvement for relationship-based queries at the cost of an LLM provider, a sync pipeline, a cross-language integration layer, and ongoing maintenance of a second system. If relationship-based retrieval becomes important, cheaper alternatives exist within PostgreSQL (junction tables, explicit links in metadata, tag-based grouping).

### Next steps

1. **No action required.** The evaluation confirms the current architecture is appropriate.

2. **Revisit if the use case changes.** If agent-brain evolves to ingest long-form documents (session transcripts, meeting notes, design docs) rather than discrete memories, LightRAG's extraction pipeline becomes relevant. At that point, a complementary deployment would be worth re-evaluating.

3. **Consider lightweight relationship tracking independently.** If "what decisions relate to this learning?" queries become common, a simple `memory_links` table (source_id, target_id, relation_type) in PostgreSQL would provide explicit relationship tracking without LightRAG's infrastructure cost. This is a feature decision for agent-brain, not a LightRAG integration question.
