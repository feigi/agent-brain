# agent-brain vs bkmr

## Introduction

This document compares [agent-brain](https://github.com/feigi/agent-brain) (a custom MCP memory server) with [bkmr](https://github.com/sysid/bkmr) (a local-first, Rust-based bookmark and knowledge-management CLI with agent-memory capabilities). The goal is to decide between three options:

1. **Adopt bkmr** -- replace agent-brain entirely, using bkmr as the agent memory backend.
2. **Use bkmr alongside agent-brain** -- run both systems for complementary purposes.
3. **Continue with agent-brain** -- selectively port good ideas from bkmr.

### Why now

bkmr has grown beyond bookmark management into a general-purpose knowledge store for AI agents. The `_mem_` system tag and `hsearch` (hybrid FTS + semantic search) create a complete read/write memory interface that overlaps with agent-brain's core purpose. With local ONNX embeddings (no API keys), a skill protocol defining memory taxonomy, and editor integrations, bkmr is the first tool in this comparison space that was also designed with agent workflows in mind from the start. Understanding the overlap and gaps is necessary before deciding whether agent-brain can be simplified, deprecated, or augmented.

### Decision criteria

The criteria, in priority order:

1. **Architectural fit** -- Does bkmr's data model and agent interface align with agent-brain's use case? A tool swap that requires extensive adaptation negates the benefit.
2. **Maintenance burden** -- How much ongoing work does each option require? A solo maintainer cannot absorb unbounded maintenance cost.
3. **Operational complexity** -- What does deployment, monitoring, and day-to-day operation look like?
4. **Multi-user support** -- Can the tool support a shared team memory, or is it inherently single-user?
5. **Memory safety** -- Does the tool prevent data loss, race conditions, and runaway agent writes?
6. **Community health** -- Contributor activity, issue response times, release cadence, bus factor.

### Out of scope

The following are explicitly excluded from this comparison:

- **bkmr's non-memory features** -- bookmarks, shell scripts, snippets, markdown rendering, LSP server, and editor plugins are not evaluated. We focus solely on the `_mem_` use case.
- **Migration cost** -- This is a one-time cost and should not drive the long-term architectural decision.
- **Programming language choice** -- Not a deciding factor.
- **Jinja2 template interpolation** -- Useful for general bookmarks; not relevant for agent memory.

## Agent-Brain

### Core model

A memory in agent-brain is a single PostgreSQL row in the `memories` table. Each row carries `id` (nanoid), `content` (free text), `title` (auto-generated from the first 80 characters of content when omitted), a typed `type` enum (`fact`, `decision`, `learning`, `pattern`, `preference`, `architecture`), a `scope` enum (`workspace`, `user`, `project`), free-form `tags` (text array), `author`, `source` (manual, agent-auto, session-review, or custom), an extensible `metadata` JSONB column, and a `version` integer for optimistic locking. Timestamps include `created_at`, `updated_at`, `verified_at`, `archived_at`, and `last_comment_at`. The `embedding` column stores a pgvector vector whose dimensionality is configurable at startup via the `EMBEDDING_DIMENSIONS` environment variable (default 768).

There are no LLM calls anywhere in the write path. When a memory is created, the service concatenates `title + "\n\n" + content`, passes that string to the configured embedding provider (a pure vector-embedding call, not a generative model), and inserts the row. If the embedding call fails, the entire create is aborted -- no partial state is ever persisted. The same re-embedding happens on updates that change content or title. This means the system never rewrites, summarizes, or extracts facts from user input; what you store is exactly what you wrote.

Before insertion, a three-stage guard chain runs: scope validation (workspace_id required for non-project scopes, project scope blocked for autonomous sources), budget checking (autonomous writes from `agent-auto` or `session-review` sources are capped per session, configurable via `WRITE_BUDGET_PER_SESSION`, default 10), and semantic duplicate detection (cosine similarity against existing memories, threshold configurable via `DUPLICATE_THRESHOLD`, default 0.90). If a near-duplicate is found, the create returns a skip result pointing to the existing memory rather than inserting a new row.

### Search and retrieval

Search works in two stages. The query text is embedded via the same provider used at write time. The repository layer runs a cosine-distance query against pgvector's HNSW index (configured with `m: 16`, `ef_construction: 64`, using `vector_cosine_ops`), over-fetching 3x the requested limit. The application layer then re-ranks those candidates with a composite scoring function and returns the top N.

The composite score formula is: `relevance = (0.80 * similarity) + (0.15 * recencyDecay) + (verified ? 0.05 : 0)`. Recency decay is exponential, halving every `RECENCY_HALF_LIFE_DAYS` (default 14). The result is clamped to [0, 1]. A minimum similarity threshold (default 0.3) filters out low-quality matches before re-ranking.

Scope filtering happens in a single SQL query. Workspace-scoped searches include workspace memories plus any project-scoped memories. User-scoped searches include the user's private memories plus project-scoped ones. A cross-scope ("both") mode unions workspace, user, and project memories in one query. All queries always filter by `project_id` for deployment isolation, and archived memories (non-null `archived_at`) are excluded everywhere.

Listing supports cursor-based pagination, filtering by type and tags, and sorting by `created_at` or `updated_at` in either direction.

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

10 production dependencies, approximately 3,700 lines of TypeScript across 41 files. Layered architecture: tools → services → repositories → Drizzle → PostgreSQL. No ORM magic, no dependency injection framework, no runtime code generation.

## bkmr

### Core model

A memory in bkmr is a SQLite row in the `bookmarks` table. The key fields are: `id` (auto-incremented integer), `URL` (the actual memory content for `_mem_` bookmarks -- the field name is a legacy artifact; it stores arbitrary text, not just URLs), `title` (human-readable name), `description` (optional notes; not included in embeddings), `tags` (comma-delimited string in the format `,tag1,tag2,`), `access_count` (integer, auto-incremented on open), `created_at`, `updated_at`, `accessed_at`, `embedding` (binary blob of serialized f32 vector), `content_hash` (for file-import change detection), `embeddable` (boolean flag), `file_path`/`file_mtime`/`file_hash` (for imported files), and `opener` (custom action command).

There is no LLM call in the write path. Memory content is embedded using a local ONNX model via the `fastembed` library. The embedding content is constructed as: `"{visible_tags}{title} -- {content}{visible_tags}"` -- a formula that embeds tags twice (prepended and appended), which bakes tag semantics into the vector. System tags (those starting and ending with `_`) are excluded from the embedding to avoid index pollution.

The type system is enforced at the domain level: a bookmark may have **at most one** system tag (`_snip_`, `_shell_`, `_md_`, `_env_`, `_imported_`, `_mem_`). For `_mem_` bookmarks specifically, the `url` field stores the memory content (not a link), and `bkmr open` prints it to stdout rather than opening a browser.

There is no automatic duplicate detection. The bkmr-memory skill recommends running `bkmr hsearch` before adding to avoid duplicates, but this is convention only -- nothing enforces it. There is no write budget, no per-session rate limiting, and no optimistic locking. Two concurrent writes can silently overwrite each other.

### Search and retrieval

bkmr provides three search modes for memories:

1. **Full-text search (`search`)**: SQLite FTS5 index over url, title, description, and tags. Supports exact phrases, boolean operators (`AND`, `OR`, `NOT`), and tag filtering (`-t` for AND, `-n` for OR, `-N` for exclude). Fast; keyword-exact.

2. **Semantic search (`sem-search`)**: Cosine similarity over the `vec_bookmarks` table (sqlite-vec extension). Fully offline, no API keys. Returns the top N most similar memories by vector distance. No scoring formula beyond raw cosine similarity.

3. **Hybrid search (`hsearch`)**: Combines FTS5 and vector results using Reciprocal Rank Fusion (RRF). Each method contributes a ranked list; RRF merges them by reciprocal rank. The combined `rrf_score` is returned in JSON output. This is the recommended default for agent use.

Tag filtering applies across all three modes. The `-n` (any-tag OR) flag enables category scoping (e.g., `-n gotcha` to show only gotcha-tagged memories). Results include `id`, `url` (content), `title`, `tags`, and `rrf_score` (for hsearch) or `access_count`/timestamps (for search).

There is no composite relevance scoring beyond raw similarity and RRF rank. There is no recency decay, no verification boost, and no scope filtering -- all memories in the database are visible to all queries.

### LLM integration

No generative LLM is used at any point, at write or read time. The only AI/ML call is local vector embedding via `fastembed` and ONNX Runtime. The model is downloaded once and cached locally (`~/.cache/bkmr/models/` by default via `FASTEMBED_CACHE_DIR`). The model is loaded lazily on first embedding call.

Seven models are supported out of the box: `NomicEmbedTextV15` (default, 768 dims), `NomicEmbedTextV15Q` (quantized, 768 dims), `AllMiniLML6V2` (384 dims), `AllMiniLML6V2Q` (quantized, 384 dims), `BGESmallENV15` (384 dims), `BGESmallENV15Q` (quantized, 384 dims), and `BGEM3` (1024 dims). Model selection is via configuration. Adding a new model requires a code change (one match arm in the Rust source), not just a config key.

### Deployment and operations

bkmr is a **single binary** (Rust, compiled via cargo). There is no server process, no daemon, no HTTP endpoint. Each invocation is a short-lived CLI process. No Docker is required. The database is a single SQLite file (default `~/.config/bkmr/bkmr.db`, configurable via `BKMR_DB_URL`). The ONNX runtime is a required dynamic library for embeddings (`libonnxruntime`); it must be installed separately on macOS (e.g., via Homebrew: `brew install bkmr && export ORT_DYLIB_PATH=/opt/homebrew/lib/libonnxruntime.dylib`). On Linux and Windows the binary bundles it.

Distribution is via `cargo install bkmr`, `pip install bkmr` (Python bindings via PyO3), or `brew install bkmr`. Migrations run automatically on `bkmr create-db`. There is no rolling migration system; schema changes are handled by the binary itself.

### Multi-user support

bkmr has **no multi-user model**. The database is a local file owned by one operating system user. There are no scopes, no workspaces, no `user_id`, and no `author` field. All memories are visible to whoever has access to the SQLite file. Sharing a memory requires sharing the file or exporting via `bkmr load-json`.

There is no concept of "team memory" vs "personal memory." The `project:foo` tag convention (recommended by the skill) provides a soft scoping by project, but it is purely by tag discipline -- there is no enforcement.

### Memory lifecycle

- **Deletion**: Permanent (hard delete via `bkmr delete <id>`). There is no soft delete, no archive, and no recovery.
- **Updates**: Via `bkmr update --url "..." --title "..." -d "..." <id>`. Each update replaces the content and re-embeds. No version field, no optimistic locking.
- **Access tracking**: `access_count` and `accessed_at` are incremented on `bkmr open`. This provides a popularity signal but is not used in search ranking.
- **Staleness detection**: None. The skill recommends periodic reviews, but there is no automated staleness flag or verification timestamp.
- **Write budget**: None. An agent can write unbounded memories without any rate limit.
- **Deduplication**: None built-in. The skill mandates a pre-add `hsearch` check, but this is convention only.
- **Content hash**: Stored for file-imported bookmarks to detect file changes, not for memory deduplication.
- **Backfill**: `bkmr backfill` generates missing embeddings for entries where `embedding IS NULL`. `bkmr clear-embeddings` clears all embeddings for a fresh re-embed with a different model.

### Collaboration

bkmr has **no collaboration features**. There are no comment threads, no activity feeds, no "what changed since my last session" bootstrapping, and no capability booleans. The tool is single-user by design.

### Extensibility

The embedding model is configurable (seven options). The `description` field is available for arbitrary notes. Custom openers (`open_with`) can override the default action per bookmark. The Python bindings (PyO3) expose the core library for embedding in Python scripts. There is no plugin API, no schema extension point, and no server to extend.

### Community

bkmr is a solo-maintainer project by [sysid](https://github.com/sysid), written in Rust with Python bindings. It was [Crate of the Week #482](https://this-week-in-rust.org/blog/2023/02/15/this-week-in-rust-482/) (February 2023). As of April 2026, the repository has approximately 244 GitHub stars, active releases with a cadence of roughly every 2--3 months (latest: v4.x series), and a BSD-3-Clause license. There are no external core contributors. The project has Homebrew, PyPI, and Crates.io distribution.

### Maintenance surface

Pure Rust core with Python bindings via PyO3. Depends on: `rusqlite` (SQLite), `sqlite-vec` (vector search), `fastembed` (ONNX embeddings), `skim`/`fzf` (interactive search), `derive_builder`, `chrono`, `serde`. No server framework, no ORM. Total control of the SQLite layer. The agent-facing skill (`skill/bkmr-memory/SKILL.md`) is a Markdown document maintained separately from the binary -- convention drift between the skill and binary behavior is a risk.

## Gap Analysis

### Data model and content types

Agent-brain has a purpose-built memory schema: a typed `type` enum, a `scope` enum, a `source` field, a `metadata` JSONB column, a `version` field, and multiple timestamps (`verified_at`, `archived_at`, `last_comment_at`). Every field exists specifically for the memory lifecycle.

bkmr's data model is a general bookmark schema that repurposes the `url` field to hold memory content. The `description` field is intentionally excluded from embeddings (by design for memory use), and the taxonomy (fact/procedure/preference/episode/gotcha) is enforced only by the skill document, not by the schema. Any agent that ignores the skill can write uncategorized memories with no classification tag and the system will accept them silently.

**Agent-brain wins** on semantic richness and schema enforcement. **bkmr wins** on simplicity -- no migrations, no server, fewer concepts to understand.

### Search sophistication

Both systems use local embeddings and cosine similarity as the foundation. The differences are in the scoring layer:

- **bkmr `hsearch`**: RRF over FTS5 + vector. Simple, effective, interpretable. The `rrf_score` reflects combined rank, not a calibrated relevance value.
- **Agent-brain**: Composite score `0.80*similarity + 0.15*recencyDecay + 0.05*verified`. Recency decay halves every 14 days. Verification adds a small trust signal. Scope filtering in SQL. Results are over-fetched 3x then re-ranked in the application layer.

Agent-brain's composite formula provides a more nuanced relevance signal (recent memories surface over stale ones; verified memories are slightly preferred). bkmr's RRF is simpler and adequate for many workloads but treats a 3-year-old memory and a 3-minute-old memory identically.

**Agent-brain wins** on scoring quality. **bkmr wins** on transparency (RRF is easier to reason about than a weighted formula).

### LLM dependency

Both systems have **zero LLM cost at write time**. Neither calls a generative model. Both use local embedding models. This is a tie.

The difference is in the embedding stack: agent-brain uses Ollama (a separate server process, but highly flexible and well-supported) or AWS Bedrock; bkmr uses fastembed/ONNX directly in-process (no extra server, but requires a correctly installed ONNX runtime library). bkmr's approach is simpler operationally but requires the `ORT_DYLIB_PATH` setup on macOS.

**Tie on LLM cost. bkmr wins on operational simplicity. Agent-brain wins on embedding provider flexibility.**

### Local-first vs server model

This is the most fundamental architectural difference. bkmr is a **local-first CLI binary** -- no network, no port, no auth surface, no uptime requirement. Agent-brain is a **server process** -- it must be running for any memory operation to succeed.

For a single developer working on one machine, bkmr's local model is simpler and more resilient. For a team sharing memory across machines, or for an environment where the agent runs in a container or cloud, bkmr's model breaks down -- the SQLite file is not accessible remotely, and there is no synchronization mechanism.

**bkmr wins** for single-user, local-machine use. **Agent-brain wins** for shared, remote, or containerized deployments.

### Agent API surface: CLI subprocess vs MCP tools

Agent-brain exposes memory operations as **MCP tools** -- first-class protocol-level functions that any MCP-capable client (Claude, Copilot CLI, Cursor, etc.) can discover and call via `listTools`. No subprocess, no shell, no escaping.

bkmr exposes memory operations via a **CLI subprocess** -- the agent must shell out, construct a command string, parse JSON from stdout, and handle non-zero exit codes. This works but introduces friction:

- Shell escaping for memory content with special characters is non-trivial.
- The agent must know the exact bkmr command syntax.
- No tool discovery -- the skill document must be injected into context for the agent to know what commands to run.
- Subprocess latency (process fork + SQLite open + ONNX lazy-init) on every operation.

The bkmr-memory skill document compensates for the lack of native integration by providing detailed instructions, but this requires the skill to be loaded into context, adding token overhead.

**Agent-brain wins** decisively on agent API surface. MCP tools are the native integration point for modern AI coding assistants. CLI subprocess is a workaround.

### Multi-user and team collaboration

Agent-brain is built for teams: workspace/user/project scopes, comment threads, team activity detection (`memory_list_recent`), session-start bootstrapping that reports changes since the user's last session, and capability booleans (`can_comment`, `can_edit`, etc.). Multiple agents or users writing to the same workspace is the primary design case.

bkmr has no team model. One SQLite file, one user. The `project:foo` tag convention is the only concession to multi-project use, and it provides no access control.

**Agent-brain wins** decisively on collaboration.

### Memory lifecycle and safety

Agent-brain provides multiple safety layers that bkmr lacks entirely:

| Safety feature            | Agent-brain                    | bkmr                       |
| ------------------------- | ------------------------------ | -------------------------- |
| Soft delete (recoverable) | ✅ (archive, preserves record) | ❌ (hard delete)           |
| Write budget per session  | ✅ (default 10, configurable)  | ❌                         |
| Automatic semantic dedup  | ✅ (0.90 cosine threshold)     | ❌ (skill-only convention) |
| Optimistic locking        | ✅ (`version` field)           | ❌                         |
| Staleness detection       | ✅ (verified_at, configurable) | ❌                         |
| Verification workflow     | ✅ (verified_at, verified_by)  | ❌                         |
| Append-only comments      | ✅                             | ❌                         |

An unconstrained agent using bkmr can fill the database with duplicates, overwrite memories, delete records permanently, and leave no audit trail. Agent-brain's design assumes agents will misbehave and adds guardrails accordingly.

**Agent-brain wins** decisively on memory safety.

### Deployment and operational complexity

| Dimension          | Agent-brain                               | bkmr                            |
| ------------------ | ----------------------------------------- | ------------------------------- |
| Process model      | Long-running HTTP server                  | Short-lived CLI binary          |
| Database           | PostgreSQL + pgvector (Docker)            | SQLite (file)                   |
| Embedding server   | Ollama (Docker)                           | ONNX in-process                 |
| Network exposure   | HTTP on port (needs reverse proxy or VPN) | None                            |
| Uptime requirement | Must be running for any memory op         | None                            |
| Startup time       | Server boot (seconds)                     | Process fork (<100ms)           |
| Installation       | Docker + npm                              | cargo/pip/brew + libonnxruntime |
| Backup             | `pg_dump`                                 | `cp bkmr.db`                    |
| Migration          | Drizzle Kit (auto on boot)                | Built into binary               |

For a solo developer with no shared memory requirement, bkmr's operational profile is significantly simpler. For a team deployment, agent-brain's Docker-based model is well-understood and straightforward.

**bkmr wins** on solo-developer operational simplicity. **Agent-brain wins** for team deployment patterns.

## Scenarios

### Use bkmr as agent memory (replace agent-brain)

Replace the MCP server with bkmr + the bkmr-memory skill loaded into agent context.

**What you gain:**

- No server to run, no PostgreSQL, no Docker required.
- SQLite simplicity: one file, trivial backup, zero network exposure.
- Local ONNX embeddings with no external dependency (beyond the ONNX runtime library).
- Hybrid search (FTS + semantic via RRF) that is transparent and effective.
- Broader content management: the same tool handles bookmarks, snippets, and scripts alongside memories.

**What you lose:**

- All 7 safety features in the table above (write budget, dedup, soft-delete, locking, staleness, verification, comments).
- Native MCP integration -- agents must shell out. Every memory operation is a subprocess with command construction, escaping, and stdout parsing.
- Multi-user support and team collaboration.
- Scope system (workspace/user/project) -- memories are flat with tags only.
- Composite relevance scoring (recency decay, verification boost).
- The skill document must be in context for every session (~3K tokens of overhead).
- Deployment to a shared or remote environment is not feasible.

**Verdict:** Feasible for a single developer doing all work on one machine, not sharing memory with teammates, and willing to accept the agent API friction and lost safety guarantees. Not viable for team use.

### Use bkmr alongside agent-brain

Keep agent-brain as the primary team memory store. Use bkmr as a personal local knowledge base for non-team content (bookmarks, snippets, shell commands, personal notes).

**What you gain:**

- A fast, local tool for personal developer productivity (code snippets, shell commands, bookmarks).
- No conflict with the team memory system.
- Each tool does what it is best at: agent-brain for structured team memory via MCP; bkmr for interactive personal knowledge management.

**What you lose:**

- Two separate tools to maintain and explain.
- Context split: agent memories live in agent-brain; personal notes live in bkmr. Agents must know which tool to use.

**Verdict:** A natural separation of concerns if bkmr's non-memory features (snippets, bookmarks, shell scripts) are valuable. Low integration risk. The two systems do not conflict.

### Agent-brain only (continue unchanged)

Keep the current architecture. No changes to the MCP server, data model, or deployment.

**What you gain:**

- No migration risk.
- All existing safety features, collaboration tools, and MCP integration preserved.
- Team memory continues to work correctly.

**What you lose:**

- Nothing. Potentially miss bkmr's personal knowledge management value (out of scope for this comparison).

**Verdict:** The default recommendation for team deployments. If personal bookmark/snippet management is a pain point, adopting bkmr alongside is the lowest-risk addition.

## Recommendation

**Continue with agent-brain. Optionally adopt bkmr alongside for personal knowledge management.**

### Rationale

The analysis surfaces a fundamental mismatch between bkmr and agent-brain's use case:

1. **Agent API surface is the blocking issue.** bkmr has no MCP server. Agents must shell out, construct command strings, parse JSON from stdout, and carry the skill document in context. Agent-brain's MCP tools are discoverable, structured, and require zero prompt engineering. For a tool used by AI coding assistants as their primary memory interface, this difference is decisive.

2. **Safety guarantees cannot be retrofitted cheaply.** The seven safety features that agent-brain provides (write budget, dedup, soft-delete, locking, staleness, verification, comments) would each require custom wrapper logic on top of bkmr. The combined effort approaches reimplementing agent-brain's service layer in a different language.

3. **Multi-user is a non-starter.** If memory is shared across a team -- the primary motivation for agent-brain -- bkmr's SQLite file model is architecturally incompatible.

4. **bkmr's strengths are orthogonal to agent-brain's purpose.** Local-first simplicity, hybrid RRF search, LSP editor integration, and multi-format content management are genuinely useful, but they address personal developer productivity, not team AI agent memory.

### Ideas worth porting from bkmr

Despite the architectural mismatch, bkmr introduces several ideas worth considering for agent-brain:

- **Memory taxonomy**: bkmr's five-category skill taxonomy (fact/procedure/preference/episode/gotcha) is more intuitive than agent-brain's current six-type enum (fact/decision/learning/pattern/preference/architecture). The `episode` category (session summaries with date) and `gotcha` category (non-obvious pitfalls) are missing from agent-brain and would be valuable additions.
- **Embedding content formula**: bkmr prepends and appends visible tags to the embedded string (`"{tags}{title} -- {content}{tags}"`). Agent-brain currently embeds only `title + "\n\n" + content`. Adding tags to the embedding input would improve recall for tag-scoped queries.
- **Access count tracking**: bkmr tracks `access_count` and `accessed_at`. Agent-brain does not. Tracking read frequency could improve the composite relevance formula (frequently accessed memories are likely high-value).
- **Hybrid search (RRF)**: Agent-brain currently uses only vector similarity. Adding FTS5-style full-text search fused via RRF would improve recall for exact-phrase queries (e.g., a specific error message or config key) that vector similarity alone handles poorly.

### Next steps

1. **No migration required.** Continue running agent-brain as the primary agent memory system.
2. **Evaluate bkmr for personal use.** If personal bookmark/snippet management is a friction point, install bkmr and use it independently. The two tools coexist without conflict.
3. **Consider taxonomy update.** Add `episode` and `gotcha` to agent-brain's type enum (or rename existing types). This is a minor schema migration with a clear user-facing benefit.
4. **Consider FTS hybrid search.** Add a full-text search pass to the agent-brain search pipeline and fuse with vector results via RRF. This would close the one area where bkmr's search is arguably better.
