# Feature Research

**Domain:** AI agent long-term memory systems (MCP-first, team-oriented, coding-agent focused)
**Researched:** 2026-03-23
**Confidence:** HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete or unusable.

| Feature                                      | Why Expected                                                                                                                                                                                | Complexity | Notes                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Memory CRUD (save, read, update, delete)** | Fundamental operations. Every memory system (Mem0, Zep, Hindsight, Anthropic's KG server) provides these. Without full CRUD, agents cannot manage their own knowledge.                      | LOW        | Expose as MCP tools: `save_note`, `get_note`, `update_note`, `archive_note`. Mem0 uses `add_memories`, `search_memory`, `list_memories`, `delete_all_memories`. Our existing tool design is sound. |
| **Semantic search via vector embeddings**    | Core retrieval mechanism. Every production memory system uses vector similarity search. Without it, agents can only do exact-match lookups, which defeats the purpose.                      | MEDIUM     | Amazon Titan embeddings via Bedrock ($0.02/1M tokens). pgvector for storage. Must support hybrid retrieval (semantic + keyword) eventually, but pure semantic is sufficient for v1.                |
| **Memory persistence across sessions**       | The entire value proposition. If memories disappear when a session ends, the system has no purpose. Every competitor (Mem0, Zep, Letta, Hindsight, GitHub Copilot Memory) provides this.    | LOW        | Postgres provides durable storage. Straightforward.                                                                                                                                                |
| **Memory scoping (project-level)**           | Repo/project-scoped memory is how GitHub Copilot Memory, OpenMemory, and all coding-agent memory systems work. Without project scoping, memories from unrelated projects pollute retrieval. | MEDIUM     | Project-scoped queries filter by project identifier. GitHub Copilot scopes to repositories. Our "project-level" scope maps to this pattern. Must prevent cross-project leakage.                    |
| **Memory scoping (user-level)**              | User preferences, personal patterns, and individual context need to persist across projects. Mem0 supports user/session/agent scopes. Vertex AI Memory Bank scopes to `user_id`.            | MEDIUM     | User memories follow the user across projects. Separate namespace from project memories. Both scopes must be searchable independently and together.                                                |
| **Manual user saves via tools**              | Users must be able to explicitly tell the agent "remember this." Every memory system supports explicit write operations. This is the most basic interaction pattern.                        | LOW        | Already designed: `save_note` tool. Agent calls it when user says "remember X." Straightforward MCP tool.                                                                                          |
| **Session-start memory loading**             | Agents need relevant context at the beginning of each session. GitHub Copilot, doobidoo/mcp-memory-service, and OpenMemory all auto-retrieve relevant memories at session start.            | MEDIUM     | Triggered by session-start hook or first tool call. Query both project and user memories. Must be fast (<500ms) and relevant (not noisy). Return top-N most relevant memories.                     |
| **Memory search with results**               | Agents and users need to search existing memories by topic. Every system provides this. Without searchable memory, the system is write-only.                                                | LOW        | `search_memory` tool with query parameter. Returns ranked results with relevance scores. Already in our design.                                                                                    |
| **Basic metadata on memories**               | Timestamps, author, tags/categories. Every system tracks when memories were created and by whom. Mem0 timestamps and versions every memory.                                                 | LOW        | Store: created_at, updated_at, author, project_id, user_id, tags. Standard relational data alongside vector embeddings.                                                                            |

### Differentiators (Competitive Advantage)

Features that set this product apart. Not expected in every memory system, but valuable for the coding-agent team use case.

| Feature                                      | Value Proposition                                                                                                                                                                                                                                                                                                                                      | Complexity | Notes                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Team sharing with access control**         | Most memory systems are single-user (OpenMemory, Anthropic's KG server, Letta). Mem0 and Zep offer team features but as cloud SaaS. Self-hosted team sharing for coding agents is underserved. GitHub Copilot Memory has repo-scoped team sharing but is locked to their ecosystem.                                                                    | HIGH       | Multiple users see shared project memories. Requires auth layer. Contributors with write access create memories; anyone with read access can retrieve. Maps to GitHub Copilot's model. This is our core differentiator: open-source, self-hosted team memory.                   |
| **Agent auto-write (autonomous capture)**    | Most systems require explicit user action. Letta pioneered agent-self-editing memory. GitHub Copilot's agent stores facts when it discovers "actionable patterns." doobidoo's system has mid-conversation hooks. Agent-initiated memory creation is the frontier feature that separates sophisticated systems from simple note stores.                 | HIGH       | Agent judges what is worth remembering mid-session without user prompting. Requires system prompt guidance defining what constitutes a memorable insight (decisions, patterns, gotchas, architecture choices). Risk: noise if capture threshold is too low. Start conservative. |
| **Session-end review and extraction**        | doobidoo/mcp-memory-service implements session-end hooks that analyze the conversation and extract learnings. Most systems lack this. It captures insights that neither the user nor the agent explicitly flagged during the session.                                                                                                                  | MEDIUM     | Session-end hook analyzes conversation, extracts key learnings, and stores them. Requires summarization/extraction logic. Can be LLM-driven (ask the agent to reflect on what was learned).                                                                                     |
| **Memory categories/types**                  | Structured memory types (facts, decisions, learnings, patterns, preferences, architecture choices) improve retrieval precision. Mem0 tags by type (user_preference, implementation). Hindsight distinguishes World facts, Experiences, and Mental Models. GitHub Copilot stores "coding conventions, architectural patterns, cross-file dependencies." | LOW        | Tag memories with type enum. Use for filtered retrieval: "show me all architecture decisions." Types from PROJECT.md: facts, decisions, learnings, patterns, user preferences, architectural choices. Start with a simple tag field.                                            |
| **System prompt guidance for capture**       | Tell agents what to look for: "When you discover a project convention, architectural decision, or gotcha, save it." This shapes agent judgment about what is worth remembering. doobidoo/mcp-memory-service provides rule-based triggers.                                                                                                              | LOW        | Ship a CLAUDE.md-style instruction set that defines memory-worthy patterns. Not code -- just well-crafted prompts that guide agent behavior. Our existing CLAUDE.md already does this for the agent-memory note system.                                                         |
| **Relevance scoring with recency weighting** | Production systems combine semantic similarity with time-based decay. Typical weights: relevance 0.6, recency 0.25, importance 0.15. Prevents stale memories from dominating retrieval. Without this, a year-old memory about a deprecated API ranks equally with yesterday's correction.                                                              | MEDIUM     | Score = (semantic*similarity * 0.6) + (recency*factor * 0.25) + (importance \* 0.15). Recency uses exponential decay. Importance from explicit flags or access frequency. Configurable weights per project.                                                                     |
| **Threaded notes (comments on memories)**    | Turn memories into living documents that evolve. Our existing design has `comment_note` which appends threaded comments. No competitor does this. Most systems overwrite or create new memories. This preserves history and context.                                                                                                                   | LOW        | Already designed in our system. Append comments to existing notes rather than replacing them. Valuable for team collaboration: Alice creates a note, Bob adds context, Charlie confirms.                                                                                        |
| **Staleness detection and verification**     | Prompt users to verify old memories. Our existing design has `verify_note` (updates verified_at) and `list_stale`. GitHub Copilot auto-expires memories after 28 days. Vertex AI supports TTL. Stale memory is worse than no memory -- it creates false confidence.                                                                                    | LOW        | Track verified_at timestamp. Flag memories older than configurable threshold (default: 30 days). `list_stale` surfaces memories needing review. Agent can ask "Is this still accurate?" during session.                                                                         |
| **Memory export and portability**            | Mem0 supports structured JSON export. Claude supports memory import from other providers. Agent-life provides portable snapshots. Lock-in is a valid concern for team knowledge.                                                                                                                                                                       | LOW        | Export memories as structured JSON. Import from other systems. Prevents vendor lock-in on team knowledge. Important for trust but not for v1 launch.                                                                                                                            |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems. Deliberately NOT building these.

| Feature                                          | Why Requested                                                                                                                                                       | Why Problematic                                                                                                                                                                                                                                                                                 | Alternative                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Knowledge graph with entity resolution**       | Hindsight, Zep/Graphiti, and Cognee use knowledge graphs. Seems like the sophisticated approach. "Alice" and "my coworker Alice" should resolve to the same entity. | Enormous complexity. Zep's Graphiti requires Neo4j + separate LLM calls for entity extraction. Adds latency, infrastructure cost, and failure modes. Knowledge graphs shine at scale (10K+ memories) but our target users will have 100s-1000s of memories per project. Premature optimization. | Simple tagged notes with semantic search. If entity resolution becomes needed later, add it as a retrieval enhancement layer, not a storage layer.                                              |
| **Real-time sync between agents**                | Two agents working on the same project simultaneously should see each other's memories instantly.                                                                   | Eventual consistency is fine for memory (per PROJECT.md). Real-time sync adds WebSocket infrastructure, conflict resolution complexity, and distributed systems problems. Memories are not chat messages -- a few seconds of delay is acceptable.                                               | Postgres-backed storage with normal read consistency. If Agent A saves a memory, Agent B sees it on next query (seconds later).                                                                 |
| **Automatic memory consolidation/merging**       | Hindsight and doobidoo/mcp-memory-service run background consolidation that deduplicates and merges related memories. Reduces memory bloat.                         | Requires background processing infrastructure, LLM calls for merge decisions, and introduces risk of information loss through bad merges. Complex to get right -- Hindsight dedicated significant engineering to this. Premature for v1.                                                        | Manual curation via `archive_note` and team review. Let users decide what to consolidate. Add automated consolidation if memory count becomes a retrieval problem (>1000 per project).          |
| **Web UI / Dashboard**                           | OpenMemory has a dashboard for browsing, adding, and deleting memories. Visual interface for memory management.                                                     | Agents are the primary consumers (per PROJECT.md). Building a web UI diverts effort from the MCP interface that agents actually use. Dashboard is a nice-to-have for debugging but not core value.                                                                                              | MCP tools provide full CRUD. If a visual interface is needed, build a simple CLI tool first. Web UI is a v2+ concern.                                                                           |
| **Memory decay with automatic deletion**         | Vertex AI supports TTL. GitHub Copilot auto-expires after 28 days. Automatic cleanup prevents memory bloat.                                                         | Automatic deletion risks losing valuable long-term knowledge. A 6-month-old architecture decision is MORE valuable than a 2-day-old debugging note. Time-based deletion is too blunt.                                                                                                           | Use relevance scoring with recency weighting for retrieval ranking (stale memories rank lower) combined with staleness detection that prompts human review before archiving. Never auto-delete. |
| **Multi-model embedding support**                | Support OpenAI, Cohere, Voyage, local models alongside Titan. Maximum flexibility.                                                                                  | Mixing embedding models in the same vector space produces garbage results. Switching models requires re-embedding all existing memories. The abstraction layer already allows swapping providers, but the practical reality is: pick one and stick with it per deployment.                      | Abstracted embedding provider interface (already planned) allows swapping the provider, but a single deployment uses one model. Migration tooling for re-embedding if provider changes.         |
| **Implicit memory capture (capture everything)** | Auto-capture every conversation turn, every file change, every decision without explicit action. Maximum coverage.                                                  | Noise destroys retrieval precision. Storing every interaction verbatim is "almost always wrong" (Letta research). Mem0 research shows selective memory outperforms full capture by 26%. Too much memory is worse than too little.                                                               | Layered write triggers: agent judgment (selective) + system prompt guidance (what matters) + session-end review (catch what was missed) + manual user saves (explicit). Quality over quantity.  |
| **Complex permission models (RBAC, ACLs)**       | Enterprise customers want granular permissions: read-only memories, admin-only memories, per-team visibility.                                                       | Over-engineering for v1. Two scopes (project + user) with simple access control (project members see project memories, only you see your user memories) covers 95% of use cases. Complex RBAC adds auth complexity without clear user value at current scale.                                   | Simple model: project memories visible to all project members, user memories visible only to that user. Add granular permissions only when real users request them.                             |

## Feature Dependencies

```
[Semantic Search (vector embeddings)]
    |
    +--requires--> [Embedding Provider (Titan/Bedrock)]
    +--requires--> [Storage Layer (Postgres + pgvector)]
    |
    +--enables---> [Session-Start Memory Loading]
    +--enables---> [Relevance Scoring with Recency]
    +--enables---> [Agent Auto-Write]

[Memory CRUD]
    |
    +--requires--> [Storage Layer]
    +--requires--> [Memory Scoping (project + user)]
    |
    +--enables---> [Threaded Notes (comments)]
    +--enables---> [Staleness Detection]
    +--enables---> [Memory Categories/Types]
    +--enables---> [Memory Export]

[Memory Scoping]
    |
    +--requires--> [Storage Layer]
    |
    +--enables---> [Team Sharing]

[Team Sharing]
    |
    +--requires--> [Memory Scoping]
    +--requires--> [Authentication & Authorization]

[Agent Auto-Write]
    |
    +--requires--> [Semantic Search]
    +--requires--> [Memory CRUD]
    +--requires--> [System Prompt Guidance]
    |
    +--enhances--> [Session-End Review]

[Session-End Review]
    |
    +--requires--> [Memory CRUD]
    +--requires--> [Agent Auto-Write patterns]

[Session-Start Memory Loading]
    |
    +--requires--> [Semantic Search]
    +--requires--> [Relevance Scoring]

[Staleness Detection]
    |
    +--requires--> [Memory CRUD (verified_at field)]
    +--enhances--> [Session-Start Loading (skip stale)]
```

### Dependency Notes

- **Semantic Search requires Embedding Provider + Storage:** Cannot search without embeddings and a vector store. These are foundational infrastructure.
- **Team Sharing requires Auth:** Multi-user access demands identity and authorization. This is the highest-complexity dependency chain.
- **Agent Auto-Write requires System Prompt Guidance:** Without guidance on what constitutes a memory-worthy insight, agents will either save too much (noise) or too little (missing value). The prompt IS the feature.
- **Session-Start Loading requires Relevance Scoring:** Loading all memories would overwhelm the context window. Must rank and select top-N. Relevance scoring is prerequisite.
- **Session-End Review enhances Agent Auto-Write:** These are complementary capture mechanisms. Auto-write catches in-the-moment insights; session-end review catches what was missed.

## MVP Definition

### Launch With (v1)

Minimum viable product -- what is needed to validate that team memory for coding agents works.

- [ ] **MCP server with memory CRUD tools** -- Foundation. Without tools, agents cannot interact with the system.
- [ ] **Semantic search via vector embeddings** -- Core retrieval. Agents need to find relevant memories, not just list them.
- [ ] **Postgres + pgvector storage layer** -- Durable, queryable storage with vector search in one database.
- [ ] **Abstracted embedding provider (Titan default)** -- Decoupled from AWS. Swap later without rewriting.
- [ ] **Two memory scopes (project + user)** -- Agents need both project context and personal preferences.
- [ ] **Manual user saves** -- The simplest memory creation path. User says "remember this," agent calls `save_note`.
- [ ] **Session-start auto-load** -- Load relevant memories when a session begins. The primary read path.
- [ ] **System prompt guidance** -- CLAUDE.md instructions defining what is worth remembering. Shapes agent behavior.
- [ ] **Basic metadata** -- Timestamps, author, project_id, tags.
- [ ] **Memory categories/types** -- Simple tag field for memory type (fact, decision, learning, pattern, preference, architecture).

### Add After Validation (v1.x)

Features to add once core is working and real users provide feedback.

- [ ] **Agent auto-write (autonomous capture)** -- Add when manual saves are validated and we understand what agents should capture. Trigger: users report "I wish the agent had remembered X without me telling it."
- [ ] **Session-end review** -- Add when auto-write patterns are established. Trigger: users find valuable insights are being lost between sessions.
- [ ] **Team sharing with auth** -- Add when multiple users need the same project memories. Trigger: more than one person is using the system on the same project.
- [ ] **Relevance scoring with recency weighting** -- Add when memory count grows large enough that naive semantic search returns stale results. Trigger: >100 memories per project.
- [ ] **Threaded notes (comments)** -- Add when teams are actively collaborating on shared memories. Trigger: users want to add context to existing notes without overwriting.
- [ ] **Staleness detection** -- Add when memory age becomes a reliability concern. Trigger: users encounter outdated memories that mislead agents.
- [ ] **Memory export** -- Add when users express concern about data portability. Trigger: explicit user request or competitive pressure.

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **Knowledge graph / entity resolution** -- Defer until memory count exceeds 1000+ per project and semantic search precision degrades. Only then does graph structure add retrieval value.
- [ ] **Automatic memory consolidation** -- Defer until memory bloat is a real problem with real users. Requires significant engineering and risk of information loss.
- [ ] **REST API interface** -- Defer. MCP-first. Add REST when non-MCP consumers emerge.
- [ ] **Web dashboard** -- Defer. Agents are primary consumers. CLI tooling first if visual debugging is needed.
- [ ] **Cross-repository memory sharing** -- Defer. Start with strict project isolation. Add cross-project features when users have multi-repo codebases with shared conventions.
- [ ] **Memory import from other systems** -- Defer. Build export first. Import adds parsing complexity for formats we cannot control.

## Feature Prioritization Matrix

| Feature                         | User Value | Implementation Cost | Priority |
| ------------------------------- | ---------- | ------------------- | -------- |
| Memory CRUD tools               | HIGH       | LOW                 | P1       |
| Semantic search                 | HIGH       | MEDIUM              | P1       |
| Postgres + pgvector storage     | HIGH       | MEDIUM              | P1       |
| Abstracted embedding provider   | MEDIUM     | MEDIUM              | P1       |
| Memory scoping (project + user) | HIGH       | MEDIUM              | P1       |
| Manual user saves               | HIGH       | LOW                 | P1       |
| Session-start auto-load         | HIGH       | MEDIUM              | P1       |
| System prompt guidance          | HIGH       | LOW                 | P1       |
| Memory categories/types         | MEDIUM     | LOW                 | P1       |
| Basic metadata                  | MEDIUM     | LOW                 | P1       |
| Agent auto-write                | HIGH       | HIGH                | P2       |
| Session-end review              | MEDIUM     | MEDIUM              | P2       |
| Team sharing + auth             | HIGH       | HIGH                | P2       |
| Relevance scoring + recency     | MEDIUM     | MEDIUM              | P2       |
| Threaded notes                  | MEDIUM     | LOW                 | P2       |
| Staleness detection             | MEDIUM     | LOW                 | P2       |
| Memory export                   | LOW        | LOW                 | P2       |
| Knowledge graph                 | MEDIUM     | HIGH                | P3       |
| Auto-consolidation              | LOW        | HIGH                | P3       |
| Web dashboard                   | LOW        | HIGH                | P3       |
| REST API                        | LOW        | MEDIUM              | P3       |

**Priority key:**

- P1: Must have for launch
- P2: Should have, add when triggered by user feedback
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature             | Mem0 (OpenMemory)       | Zep (Graphiti)                       | Hindsight                                   | GitHub Copilot Memory                     | Letta (MemGPT)    | Anthropic KG Server                   | Our Approach                             |
| ------------------- | ----------------------- | ------------------------------------ | ------------------------------------------- | ----------------------------------------- | ----------------- | ------------------------------------- | ---------------------------------------- |
| Memory CRUD         | Yes                     | Yes                                  | Yes (retain/recall/reflect)                 | Agent-driven only                         | Agent self-edit   | Yes (entities/relations/observations) | Yes -- MCP tools                         |
| Semantic search     | Yes (vector)            | Yes (hybrid: vector + BM25 + graph)  | Yes (4 strategies in parallel)              | Yes (with citation verification)          | Yes (LLM-managed) | No (graph traversal)                  | Yes (vector, hybrid later)               |
| Memory scoping      | User/session/agent      | User/organization                    | Tag-based                                   | Repository-scoped                         | Agent-scoped      | None (local file)                     | Project + user scopes                    |
| Team sharing        | Cloud platform          | Cloud platform                       | Not yet                                     | Repo contributors                         | Server-based      | No (single user)                      | Self-hosted, auth-gated                  |
| Auto-capture        | Via extraction pipeline | Via conversation processing          | Via fact extraction                         | Agent judgment                            | Agent self-edit   | No                                    | Agent judgment + system prompt guidance  |
| Knowledge graph     | Yes (graph store)       | Yes (temporal KG, core feature)      | Yes (entity resolution)                     | No (flat facts)                           | No                | Yes (core feature)                    | No (v1). Flat notes with semantic search |
| Conflict resolution | Newest wins             | Temporal bi-model, preserves history | Preserves both states with temporal markers | Citation-based verification, self-healing | LLM decides       | Manual                                | Manual review + staleness detection      |
| Memory decay        | Not explicit            | Temporal weighting                   | Temporal filtering                          | Auto-expire 28 days                       | LLM-managed       | No                                    | Relevance scoring (no auto-delete)       |
| Session hooks       | No                      | No                                   | No                                          | Cross-agent                               | No                | No                                    | Session-start load, session-end review   |
| Open source         | Open core               | Apache 2.0 + Commercial              | Open source                                 | Proprietary                               | Apache 2.0        | MIT                                   | Open source                              |
| Self-hosted         | Yes                     | Yes                                  | Yes                                         | No (GitHub only)                          | Yes               | Yes (local file)                      | Yes (Postgres + AWS)                     |
| MCP support         | Yes (OpenMemory MCP)    | No (REST API)                        | Yes (MCP server)                            | No (proprietary)                          | No (REST API)     | Yes (reference impl)                  | Yes (MCP-first)                          |
| Threaded discussion | No                      | No                                   | No                                          | No                                        | No                | No                                    | Yes (comment_note)                       |

### Key Competitive Insights

1. **Team sharing for coding agents is underserved.** Mem0 and Zep offer it as cloud SaaS. GitHub Copilot has repo-scoped sharing but is proprietary. Self-hosted, open-source team memory with MCP compatibility has no strong competitor.

2. **Knowledge graphs are popular but premature for our scale.** Zep and Hindsight invest heavily in graph-based retrieval. For <1000 memories per project, semantic search with metadata filtering is sufficient and far simpler.

3. **Session lifecycle hooks are rare.** Only doobidoo/mcp-memory-service implements proper session-start and session-end hooks. This is a practical differentiator for coding agents.

4. **Threaded notes are unique.** No competitor supports comment threads on memories. This is genuinely novel for team collaboration on shared knowledge.

5. **MCP-first is the right bet.** Mem0, Hindsight, and Anthropic's KG server all ship MCP servers. Zep and Letta are REST-first. MCP adoption is accelerating across Claude Code, Cursor, and VS Code.

## Sources

- [Hindsight MCP Memory Server (Vectorize)](https://hindsight.vectorize.io/blog/2026/03/04/mcp-agent-memory) -- Open-source MCP memory with entity resolution, multi-strategy retrieval
- [Hindsight Conflict Resolution](https://hindsight.vectorize.io/blog/2026/02/09/resolving-memory-conflicts) -- Temporal tracking, state preservation
- [Mem0 / OpenMemory](https://mem0.ai/openmemory) -- MCP memory layer for coding agents, auto-capture, dashboard
- [Mem0 Research](https://mem0.ai/research) -- 26% accuracy boost over OpenAI memory, selective retrieval
- [Zep / Graphiti](https://www.getzep.com/) -- Temporal knowledge graph, bi-temporal model, hybrid search
- [Zep Paper](https://arxiv.org/abs/2501.13956) -- Temporal KG architecture for agent memory
- [Letta (MemGPT)](https://github.com/letta-ai/letta) -- Self-editing memory, OS-inspired tiered architecture
- [GitHub Copilot Memory](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/) -- Repository-scoped, citation-verified, cross-agent, self-healing
- [GitHub Copilot Memory Docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) -- Scoping, validation, 28-day expiry
- [Anthropic Knowledge Graph Memory Server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) -- Reference MCP implementation, entities/relations/observations
- [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) -- Session hooks, memory consolidation, natural triggers
- [doobidoo Memory Hooks Guide](https://github.com/doobidoo/mcp-memory-service/wiki/Memory-Hooks-Complete-Guide) -- Session lifecycle, auto-capture patterns
- [Vertex AI Memory Bank](https://docs.cloud.google.com/agent-builder/agent-engine/memory-bank/overview) -- User-scoped, TTL, memory revisions, IAM
- [5 AI Agent Memory Systems Compared (2026)](https://dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared-mem0-zep-letta-supermemory-superlocalmemory-2026-benchmark-59p3) -- LoCoMo benchmarks, architecture comparison
- [6 Best AI Agent Memory Frameworks (2026)](https://machinelearningmastery.com/the-6-best-ai-agent-memory-frameworks-you-should-try-in-2026/) -- Framework comparison
- [IBM: What Is AI Agent Memory?](https://www.ibm.com/think/topics/ai-agent-memory) -- Memory types, auto-capture patterns
- [Redis: AI Agent Memory Architecture](https://redis.io/blog/ai-agent-memory-stateful-systems/) -- Hybrid memory systems, scoring approaches
- [Memory Consistency in AI Agents (2025)](https://sparkco.ai/blog/mastering-memory-consistency-in-ai-agents-2025-insights) -- Decay scoring, conflict resolution weights
- [AWS Multi-Tenant Agentic AI](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/agentic-ai-multitenant/agentic-ai-multitenant.pdf) -- Namespace isolation, tenant scoping
- [Claude Memory Import](https://awesomeagents.ai/news/claude-import-memory-switch-providers/) -- Memory portability across AI providers
- [Mem0 Memory Export](https://docs.mem0.ai/cookbooks/essentials/exporting-memories) -- Structured JSON export, Pydantic schemas

---

_Feature research for: AI agent long-term memory systems_
_Researched: 2026-03-23_
