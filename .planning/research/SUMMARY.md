# Project Research Summary

**Project:** agent-brain
**Domain:** AI Agent Long-Term Memory System (MCP Server)
**Researched:** 2026-03-23
**Confidence:** HIGH

## Executive Summary

Agent-brain is a team-oriented, MCP-first long-term memory server for coding agents (Claude Code, Cursor). The product fills a genuine gap: self-hosted, open-source team memory with MCP compatibility has no strong competitor. Mem0 and Zep offer team features as cloud SaaS; GitHub Copilot's repo-scoped sharing is proprietary. The recommended approach is a layered TypeScript service (MCP tools → business logic services → provider interfaces) backed by PostgreSQL + pgvector for both relational and vector storage, with Amazon Titan v2 as the default embedding provider. The architecture is intentionally simple for v1: flat notes with semantic search, two memory scopes (project and user), and a passive server that exposes tools while agent behavior is driven by system prompt instructions (CLAUDE.md).

The three most valuable differentiators to build toward are: team sharing with access control (underserved in the self-hosted space), session lifecycle hooks (session-start auto-load and session-end review — rare among competitors), and threaded note comments (no competitor implements this). These are all Phase 2 concerns; Phase 1 must validate that the core write/search loop works and delivers value before layering complexity.

The dominant risk is noise over signal: agents over-write low-value memories, retrieval quality degrades, and the system becomes useless faster than it becomes useful. Write budgets, deduplication at save time, and provenance tracking are not optional — they must be in Phase 1. The secondary risk is embedding model lock-in: raw text must always be stored alongside vectors from day one, with model metadata per row, or a future model migration becomes a data-loss event rather than a batch re-embedding job.

## Key Findings

### Recommended Stack

The stack is a tight, well-justified set of tools with no framework overhead. The MCP SDK (`@modelcontextprotocol/sdk` 1.27.x) handles protocol concerns directly — no third-party wrappers. Drizzle ORM 0.45.x provides first-class pgvector support (`vector()` column type, `cosineDistance()`, HNSW index definitions) that Prisma cannot match. PostgreSQL 17 + pgvector 0.8.x on RDS is the single database for both relational and vector data, eliminating a separate vector service. Amazon Titan Text Embeddings V2 at 512 dimensions is the pragmatic choice: 99% of 1024-dim accuracy at half the storage cost, fully within AWS ecosystem.

**Core technologies:**

- TypeScript 5.9.x + Node.js 22 LTS — type safety is non-negotiable for a schema-sensitive system; Node 22 supports native TS stripping and is LTS through April 2027
- `@modelcontextprotocol/sdk` 1.27.x — official SDK, Zod v4 schemas, stdio + Streamable HTTP transports; use directly, not wrapped
- PostgreSQL 17 + pgvector 0.8.x — single DB for relational and vector data; pgvector 0.8.x on RDS PG 17.1+ adds iterative index scans and 5.7x query performance improvement
- Amazon Titan Text Embeddings V2 at 512 dimensions — $0.02/1M tokens, AWS-native, unit-normalized for cosine similarity; 512d retains 99% accuracy of 1024d at half storage
- Drizzle ORM 0.45.x — native pgvector columns, predictable SQL, migration via drizzle-kit 0.31.x (stable pairing, do NOT use 1.0 beta)
- Vitest 4.1.x — fast, ESM-native, TypeScript-native testing

**What NOT to use:** LangChain.js (dependency bloat, wrong abstraction level), Prisma (no native pgvector), drizzle-orm 1.0 beta or TypeScript 6.0 RC (unstable), dedicated vector databases (Pinecone, Qdrant — operational complexity not warranted for thousands of vectors), `console.log` in stdio MCP servers (corrupts JSON-RPC).

### Expected Features

The product is most useful when it delivers two things quickly: agents can save and find memories within a session, and those memories persist across sessions. Everything else is an optimization.

**Must have (table stakes, v1):**

- Memory CRUD (save, get, update, archive) — MCP tools as first-class interface
- Semantic search via vector embeddings — core retrieval; exact-match alone defeats the purpose
- Memory persistence across sessions — the entire value proposition
- Memory scoping (project-level and user-level) — prevents cross-project pollution
- Manual user saves — explicit write via `save_note`; simplest interaction pattern
- Session-start auto-load — retrieve relevant memories at session begin; must be fast (<500ms) and capped
- Basic metadata (timestamps, author, project/user ID, tags, memory type)
- Memory categories/types (fact, decision, learning, pattern, preference, architecture) — simple tag enum; improves retrieval precision
- System prompt guidance (CLAUDE.md instructions) — shapes agent judgment on what is worth saving

**Should have (v1.x, add when triggered by real usage):**

- Agent auto-write (autonomous capture) — add after manual saves validated; risk of noise if threshold too low
- Session-end review and extraction — add after auto-write patterns established; catches what was missed
- Team sharing with access control — add when multiple users need shared project memory
- Relevance scoring with recency weighting — add when memory count exceeds ~100/project; Score = (semantic_similarity × 0.6) + (recency × 0.25) + (importance × 0.15)
- Threaded notes (comment_note) — already designed; unique among competitors; add when teams collaborate on shared memories
- Staleness detection (verified_at, list_stale) — already designed; add when stale memories cause real reliability issues
- Memory export (JSON) — add when data portability is explicitly requested

**Defer (v2+):**

- Knowledge graph with entity resolution — not warranted until >1000 memories/project and semantic search precision degrades
- Automatic memory consolidation/merging — information loss risk; defer until memory bloat is confirmed real
- Web UI / dashboard — agents are primary consumers; CLI first
- REST API — MCP-first; add when non-MCP consumers emerge
- Cross-repository memory sharing — start with strict project isolation

**Anti-features (deliberate non-features):**

- Real-time cross-agent sync (eventual consistency is fine for memory)
- Memory decay with automatic deletion (use recency weighting + staleness detection + human review instead)
- Complex RBAC (two scopes + simple access control covers 95% of cases)
- Implicit capture-everything (noise destroys retrieval; selective capture beats full capture by 26% per Mem0 research)

### Architecture Approach

The architecture is a clean four-layer stack: MCP tools (protocol handling, input validation) → services (business logic, orchestration) → provider interfaces (embedding, storage) → data layer (PostgreSQL + Bedrock). The server is passive — it exposes tools and data, never pushes or decides when to write. Agent behavior is driven entirely by system prompt instructions. This keeps the server simple and agent-agnostic.

**Major components:**

1. MCP Server Layer — `McpServer` with Zod-validated tools; thin dispatch to services; no business logic in tool handlers; 8 core tools mapped to 3 logical groups (memory CRUD, search, lifecycle)
2. Services Layer — MemoryService (write path: embed → store), RetrievalService (read path: embed query → vector search → score), LifecycleService (staleness, verification, archival); each independently testable
3. Provider Abstraction Layer — `EmbeddingProvider` interface (TitanProvider default) and `StorageProvider` interface (PgVectorStore default); concrete implementations injected at startup; swappable without touching business logic
4. Data Layer — PostgreSQL + pgvector; HNSW index with `m=16, ef_construction=64`; Row-Level Security for tenant isolation; JSONB for comment threads; soft deletes via `archived_at`
5. Auth Layer — AuthContext (userId + projectId) resolved at MCP connection boundary, threaded through all service calls as first argument; RLS enforces isolation at DB level as safety net

**Key patterns:**

- Provider interface abstraction: external dependencies behind interfaces, injected at startup; keeps EmbeddingProvider and StorageProvider independently swappable
- Scoped memory access via tenant context: every query scoped by project + user; RLS is the enforcement layer, application filtering is defense-in-depth
- Service layer orchestration: tools dispatch, services orchestrate, providers handle I/O; each layer testable in isolation
- Stdio for v1 transport: simpler, natively supported by Claude Code and Cursor, natural process isolation per agent session; upgrade to Streamable HTTP when remote/team access is needed

**Build order (dependency chain):**
Types/schemas → Provider interfaces + implementations + DB migrations → Services → MCP tools + auth → Integration config

### Critical Pitfalls

1. **Memory bloat from unchecked writes** — Implement write budgets (5-10 max per session, enforced server-side) and deduplication at save time (cosine similarity > 0.92 = reject or prompt merge). Must be in Phase 1 `save_note` implementation, not bolted on later. Fields for `last_accessed_at` and `access_count` required from Phase 1 even if decay scoring comes later.

2. **Embedding model lock-in** — Always store raw text alongside vectors. Record `embedding_model_id` and version on every memory row. Changing embedding models without stored raw text is a data-loss event. Abstraction layer must be real (not theoretical) from Phase 1 schema design.

3. **Conflicting and contradictory memories** — Add timestamps from Phase 1 and use recency weighting in retrieval. For Phase 2: surface near-duplicate detection on save (>0.90 similarity = prompt update-vs-create), add `supersedes` field for explicit supersession. Vector search has no built-in concept of temporal precedence.

4. **Memory poisoning in shared contexts** — Provenance tracking is a security field, not optional metadata: who wrote it (user vs. agent), which session, what triggered the write. Trust-weighted retrieval in Phase 2 (human writes rank higher than agent writes). Content sanitization on write (reject imperative-language content). RLS at DB level is mandatory for team sharing.

5. **MCP tool definitions consuming context window** — Each tool definition costs 550-1,400 tokens, serialized on every turn. 8 tools × average = 6,000-11,000 tokens before the agent processes input. Minimize tool count, keep descriptions concise, and measure token consumption as a Phase 1 acceptance criterion. Consider consolidating comment/verify/archive as actions on `update_note`.

6. **Session-start memory injection overwhelming context** — Cap auto-loaded memories at 3-5 with a strict 1,500-token budget. Use recency + access frequency (not just semantic similarity) for session-start ranking. Consider lazy loading: inject a brief summary and let the agent pull specifics on demand.

7. **Schema over-engineering before validation** — Ship the minimal schema: id, content, embedding, scope, author, timestamps, memory_type enum, embedding_model_id. Under 12 columns at launch. Add fields only when real usage patterns demand them.

## Implications for Roadmap

Based on the dependency chain in ARCHITECTURE.md, the feature priority matrix in FEATURES.md, and the pitfall-to-phase mapping in PITFALLS.md, the research points to a 4-phase structure.

### Phase 1: Foundation and Core Write/Search Loop

**Rationale:** Everything depends on the storage layer and MCP server existing. Providers must exist before services; services before tools; tools before integration. Write budgets, dedup, provenance fields, raw text storage, and embedding model metadata must all be in Phase 1 — they cannot be retrofitted without data migration. The MCP tool surface is an API contract: get it right before users depend on tool names.

**Delivers:** A working MCP server that agents can configure, save notes to, and search. Validates that the core value proposition (memories survive across sessions and are findable by semantic search) actually works.

**Addresses (from FEATURES.md P1):**

- Memory CRUD (save, get, update, archive)
- Semantic search via vector embeddings
- PostgreSQL + pgvector storage layer
- Abstracted embedding provider (Titan default)
- Two memory scopes (project + user)
- Manual user saves
- Basic metadata and memory categories/types
- System prompt guidance (CLAUDE.md)

**Avoids:**

- Memory bloat: write budgets + dedup in `save_note` from day one
- Embedding lock-in: raw text + model metadata in schema from day one
- Schema over-engineering: target <12 columns, instrument what agents actually write
- Context window bloat: measure tool definition token cost as acceptance criterion; target <3,000 tokens for the full tool set

### Phase 2: Retrieval Quality and Session Lifecycle

**Rationale:** Once basic save/search works and real usage patterns emerge (2+ weeks of real usage), retrieval quality becomes the bottleneck. This phase upgrades search from "works" to "works well." Session-start auto-load should not be built by guessing — measure what agents search for most often first. Conflict detection and trust scoring require Phase 1 provenance fields.

**Delivers:** Noticeably better memory retrieval, session-start auto-load with token budget enforcement, conflict detection on writes, and the foundation for team sharing (auth layer).

**Addresses (from FEATURES.md P2):**

- Session-start auto-load (lazy loading pattern, 3-5 memories, 1,500-token cap)
- Relevance scoring with recency weighting (formula: 0.6 semantic + 0.25 recency + 0.15 importance)
- Conflict detection on save (>0.90 similarity = prompt update-vs-create, `supersedes` field)
- Trust-weighted retrieval (human vs. agent write distinction)
- Content sanitization on write (memory poisoning prevention)
- Load testing at realistic memory volumes (pgvector performance verification)

**Avoids:**

- Session-start context overflow: token-budgeted auto-load, usage tracking
- Conflicting memories: supersession mechanism
- Memory poisoning: trust scoring + sanitization
- pgvector performance cliff: load test before team adoption

### Phase 3: Team Sharing and Collaboration

**Rationale:** Team sharing is the core differentiator but requires auth infrastructure and RLS enforcement. Build this only after the core is validated with real usage. Auth strategy needs to be isolated (per ARCHITECTURE.md) so it can evolve without touching business logic.

**Delivers:** Multiple users sharing project-scoped memories, threaded note comments (comment_note — unique differentiator), staleness detection and verification workflow, and memory export for data portability.

**Addresses (from FEATURES.md P2):**

- Team sharing with access control (project members see project memories; user memories private)
- Threaded notes (comment_note — no competitor implements this)
- Staleness detection (verified_at, list_stale, stale memory surfacing in sessions)
- Memory export (structured JSON)
- Session-end review and extraction

**Avoids:**

- Memory poisoning at team scale: RLS at DB level as enforcement layer (not just app-level filtering)
- Over-complex RBAC: two scopes only; add granular permissions only on explicit user request

**Research flag:** This phase needs `/gsd:research-phase` during planning. Auth design for MCP servers is in active evolution (MCP auth spec notes say "evolving"). The pragmatic v1 approach is static bearer tokens for internal team use, but needs verification against current MCP auth support in Claude Code and Cursor.

### Phase 4: Advanced Capture and Optimization

**Rationale:** Agent auto-write (autonomous capture) and session-end review are high-value but high-risk features that require Phase 1-3 patterns to be established first. Auto-write needs validated write budgets, dedup, and provenance tracking or it generates noise at scale. Recency weighting (Phase 2) must exist before agent-written memories can be trust-scored correctly.

**Delivers:** Autonomous agent memory capture with configurable thresholds, session-end review and learning extraction, batch re-embedding tooling for future model migrations, and performance optimizations based on real usage data.

**Addresses (from FEATURES.md P2-P3):**

- Agent auto-write (autonomous capture with budget enforcement)
- Session-end review (LLM-driven reflection, extract learnings from session)
- Batch re-embedding tooling (migration path for embedding model changes)
- Memory quality metrics (which memories are actually referenced; feedback loop)

**Avoids:**

- Noise from auto-write: conservative thresholds, system prompt guidance tuning based on real data
- Knowledge graph temptation: add only if retrieval quality demonstrably degrades at scale

### Phase Ordering Rationale

- **Dependency chain is strict:** providers before services, services before tools, tools before integration. Cannot skip or reorder.
- **Schema is an API contract:** embedding model metadata, raw text storage, write budgets, and provenance fields must be in Phase 1 because retrofitting them requires data migration; changing tool names breaks agent configurations.
- **Validate before optimizing:** session-start auto-load and relevance scoring (Phase 2) should be informed by real usage data from Phase 1, not built by guessing what agents will need.
- **Team features require auth:** auth infrastructure (Phase 3) depends on Phase 1 RLS setup in the schema and Phase 2 trust scoring foundation.
- **Auto-write is the highest-risk feature:** it requires all quality controls to be in place (budgets, dedup, provenance, trust scoring) before it can operate without generating noise. Phase 4 is the right home.

### Research Flags

Phases likely needing `/gsd:research-phase` during planning:

- **Phase 3 (Team Sharing / Auth):** MCP authentication spec is actively evolving. Need to verify current Claude Code and Cursor support for bearer tokens vs. OAuth 2.1. Static bearer tokens are pragmatic for internal teams but the integration specifics need validation.
- **Phase 4 (Agent Auto-write):** System prompt engineering for memory capture thresholds is empirically driven. The right triggers ("save architectural decisions but not debugging steps") need real usage data to calibrate. May benefit from researching system prompt patterns from doobidoo/mcp-memory-service and GitHub Copilot Memory.

Phases with standard patterns (can skip research-phase):

- **Phase 1 (Foundation):** MCP SDK, Drizzle + pgvector, Titan embeddings — all well-documented with HIGH-confidence sources. Build order is clear. No novel integrations.
- **Phase 2 (Retrieval Quality):** Recency weighting formulas, vector search optimization, and session-start loading patterns are established in research. Load testing approach is standard.

## Confidence Assessment

| Area         | Confidence | Notes                                                                                                                                                                                                                                                       |
| ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack        | HIGH       | All major dependencies verified against official sources (MCP SDK 1.27.x, pgvector 0.8.x on RDS PG 17.1+, Drizzle 0.45.x stable pairing). Version compatibility table confirmed. Zod v3/v4 peer dep resolved.                                               |
| Features     | HIGH       | Competitor analysis is extensive (8 systems compared). Table stakes are clearly established by market. Differentiators validated against gap in self-hosted team memory. Anti-features backed by specific research (Mem0 26% selective vs. full capture).   |
| Architecture | HIGH       | Four-layer architecture is standard for MCP servers. Provider interface pattern is well-established. RLS + tenant context pattern verified against AWS multi-tenant RDS documentation. Data flow diagrams are internally consistent.                        |
| Pitfalls     | HIGH       | Each pitfall cross-verified across multiple sources. Memory poisoning backed by NeurIPS 2025 research (MINJA, 95% injection rate). pgvector scaling backed by production post-mortems. Context window bloat backed by measured data (55K+ tokens observed). |

**Overall confidence:** HIGH

### Gaps to Address

- **MCP auth specifics in Phase 3:** The research flags MCP auth as "evolving" (only 8.5% of servers use OAuth). The pragmatic approach (static bearer tokens) is clear, but exact Claude Code + Cursor configuration for authenticated servers needs verification during Phase 3 planning. Validate before building.
- **Titan embedding quality on short code-context text:** Research notes Titan embeddings are "significantly worse than current open source models" on some benchmarks, but the specific use case (short text memories from coding sessions) is not benchmarked. The EmbeddingProvider abstraction exists for this reason — validate Titan quality in Phase 1 before assuming it's sufficient. If quality is poor, swap to OpenAI text-embedding-3-small (same price, better benchmarks).
- **Write budget calibration:** The research recommends 5-10 memories per session as a starting budget, but this is a starting heuristic, not validated data. Instrument actual agent write patterns in Phase 1 and adjust the budget in Phase 2 based on real usage.
- **Tool count vs. tool granularity tradeoff:** Research flags 8 tools as potentially too many (5,000-15,000 tokens of definitions). The specific consolidation decision (keep 8 distinct tools vs. consolidate comment/verify/archive into update_note) needs measurement in Phase 1. Treat tool token cost as an acceptance criterion, not an afterthought.

## Sources

### Primary (HIGH confidence)

- [MCP TypeScript SDK 1.27.x](https://github.com/modelcontextprotocol/typescript-sdk) — SDK architecture, transport options, tool definitions, Zod v4 compatibility
- [pgvector GitHub](https://github.com/pgvector/pgvector) — Extension features, HNSW/IVFFlat indexes, v0.8.x changelog
- [AWS RDS pgvector 0.8.x](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-rds-for-postgresql-pgvector-080/) — pgvector 0.8.0 support on RDS PostgreSQL 17.1+
- [AWS Titan Text Embeddings V2](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html) — Model ID, dimensions, token limits, normalization
- [Drizzle ORM pgvector guide](https://orm.drizzle.team/docs/guides/vector-similarity-search) — Vector columns, cosineDistance, HNSW index definitions
- [MINJA Memory Injection Attack (NeurIPS 2025)](https://www.lakera.ai/blog/agentic-ai-threats-p1) — Memory poisoning, 95%+ injection success rate
- [GitHub Copilot Memory](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/) — Repository-scoped memory, citation verification, 28-day expiry
- [Mem0 Research](https://mem0.ai/research) — 26% accuracy boost for selective vs. full capture

### Secondary (MEDIUM confidence)

- [MCP Authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) — OAuth 2.1 patterns; spec noted as evolving
- [Mem0 Architecture Paper](https://arxiv.org/abs/2504.19413) — Three-stage memory pipeline; informational, not a dependency
- [Hindsight MCP Memory (Vectorize)](https://hindsight.vectorize.io/blog/2026/03/04/mcp-agent-memory) — Multi-strategy retrieval, cross-encoder reranking
- [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) — Session lifecycle hooks, memory consolidation
- [pgvector 2026 Guide](https://www.instaclustr.com/education/vector-database/pgvector-key-features-tutorial-and-pros-and-cons-2026-guide/) — HNSW tuning, scaling patterns
- [MCP Server Context Window Consumption](https://www.apideck.com/blog/mcp-server-eating-context-window-cli-alternative) — Tool definition token costs (55K+ observed)
- [Amazon Titan Embeddings Benchmark](https://www.philschmid.de/amazon-titan-embeddings) — Quality limitations vs. open-source alternatives

### Tertiary (LOW confidence)

- [MCP Real Faults Taxonomy](https://arxiv.org/html/2603.05637v1) — 3,282 MCP server issues analyzed; directionally useful but broad
- [State of MCP Server Security 2025 (Astrix)](https://astrix.security/learn/blog/state-of-mcp-server-security-2025/) — 53% static secret reliance, 8.5% OAuth adoption

---

_Research completed: 2026-03-23_
_Ready for roadmap: yes_
