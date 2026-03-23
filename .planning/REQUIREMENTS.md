# Requirements: Agentic Brain

**Defined:** 2026-03-23
**Core Value:** Agents remember what matters across sessions — no team knowledge is lost because a conversation ended.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Memory Core

- [ ] **CORE-01**: User can save a memory with content, optional title, and optional tags via MCP tool
- [ ] **CORE-02**: User can retrieve a specific memory by ID via MCP tool
- [ ] **CORE-03**: User can update an existing memory's content, title, or tags
- [ ] **CORE-04**: User can archive a memory (soft delete, excluded from search but recoverable)
- [ ] **CORE-05**: User can search memories by semantic similarity and receive ranked results with relevance scores
- [ ] **CORE-06**: User can tag memories with categories (fact, decision, learning, pattern, preference, architecture)
- [ ] **CORE-07**: Memories persist across agent sessions in Postgres
- [ ] **CORE-08**: Raw text is stored alongside embeddings (enables re-embedding on provider change)
- [ ] **CORE-09**: Embedding model metadata is stored with each memory (model name, dimensions)

### Scoping

- [ ] **SCOP-01**: Memories are scoped to a project — agents only see memories for their current project
- [ ] **SCOP-02**: User-level memories follow the user across all projects
- [ ] **SCOP-03**: Agent can search both project and user memories in a single query
- [ ] **SCOP-04**: Cross-project memory leakage is prevented at the database level (RLS)

### Retrieval

- [ ] **RETR-01**: Semantic search returns memories ranked by vector similarity
- [ ] **RETR-02**: Relevance scoring combines semantic similarity with recency weighting
- [ ] **RETR-03**: Search results include relevance score, creation date, author, and tags
- [ ] **RETR-04**: Agent can auto-load relevant memories at session start based on project context
- [ ] **RETR-05**: Session-start loading returns top-N most relevant memories within a configurable limit

### Team Collaboration

- [ ] **TEAM-01**: Multiple users can read and write to shared project memories
- [ ] **TEAM-02**: Authentication identifies which user/agent is writing memories
- [ ] **TEAM-03**: Each memory records its author (provenance tracking)
- [ ] **TEAM-04**: User can append a comment to an existing memory (threaded notes)
- [ ] **TEAM-05**: Threaded comments preserve the original memory content and add context
- [ ] **TEAM-06**: User can verify a memory is still accurate (updates verified_at timestamp)
- [ ] **TEAM-07**: Agent can list memories that haven't been verified within a configurable threshold (staleness detection)

### Agent Autonomy

- [ ] **AUTO-01**: Agent can autonomously save insights mid-session without explicit user instruction
- [ ] **AUTO-02**: System prompt guidance defines what patterns are worth remembering (decisions, conventions, gotchas, architecture)
- [ ] **AUTO-03**: Agent can perform session-end review and extract key learnings
- [ ] **AUTO-04**: Write budget limits the number of autonomous saves per session (prevents memory bloat)
- [ ] **AUTO-05**: Duplicate detection prevents saving memories semantically similar to existing ones

### Infrastructure

- [ ] **INFR-01**: MCP server exposes all memory operations as tools via stdio transport
- [ ] **INFR-02**: Storage layer is abstracted behind an interface (Postgres + pgvector as default implementation)
- [ ] **INFR-03**: Embedding provider is abstracted behind an interface (Amazon Titan v2 as default implementation)
- [ ] **INFR-04**: Database schema supports pgvector with HNSW indexing for fast similarity search
- [ ] **INFR-05**: Database migrations are managed programmatically (Drizzle ORM)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Retrieval

- **ADVR-01**: Hybrid search combining semantic and keyword matching
- **ADVR-02**: Tag/category filtering on search results
- **ADVR-03**: Knowledge graph with entity resolution for cross-memory connections

### Integration

- **INTG-01**: REST API interface for non-MCP agents
- **INTG-02**: Streamable HTTP transport for remote/team MCP access
- **INTG-03**: Memory export as structured JSON for portability
- **INTG-04**: Memory import from other systems

### Management

- **MGMT-01**: Web UI dashboard for browsing and managing memories
- **MGMT-02**: CLI tool for memory management outside agent sessions
- **MGMT-03**: Automated memory consolidation/merging

## Out of Scope

| Feature | Reason |
|---------|--------|
| Knowledge graphs | Premature at expected scale (<1000 memories/project); semantic search sufficient |
| Real-time sync between agents | Eventual consistency is fine for memory; adds WebSocket/distributed complexity |
| Automatic memory deletion | Risk of losing valuable long-term knowledge; staleness detection + human review instead |
| Implicit capture-everything | Noise destroys retrieval precision; selective capture outperforms by 26% (Mem0 research) |
| Complex RBAC/ACLs | Two scopes (project + user) with simple access control covers 95% of use cases |
| Web UI | Agents are primary consumers; MCP tools provide full CRUD |
| Mobile app | Not relevant for coding agent memory |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CORE-01 | — | Pending |
| CORE-02 | — | Pending |
| CORE-03 | — | Pending |
| CORE-04 | — | Pending |
| CORE-05 | — | Pending |
| CORE-06 | — | Pending |
| CORE-07 | — | Pending |
| CORE-08 | — | Pending |
| CORE-09 | — | Pending |
| SCOP-01 | — | Pending |
| SCOP-02 | — | Pending |
| SCOP-03 | — | Pending |
| SCOP-04 | — | Pending |
| RETR-01 | — | Pending |
| RETR-02 | — | Pending |
| RETR-03 | — | Pending |
| RETR-04 | — | Pending |
| RETR-05 | — | Pending |
| TEAM-01 | — | Pending |
| TEAM-02 | — | Pending |
| TEAM-03 | — | Pending |
| TEAM-04 | — | Pending |
| TEAM-05 | — | Pending |
| TEAM-06 | — | Pending |
| TEAM-07 | — | Pending |
| AUTO-01 | — | Pending |
| AUTO-02 | — | Pending |
| AUTO-03 | — | Pending |
| AUTO-04 | — | Pending |
| AUTO-05 | — | Pending |
| INFR-01 | — | Pending |
| INFR-02 | — | Pending |
| INFR-03 | — | Pending |
| INFR-04 | — | Pending |
| INFR-05 | — | Pending |

**Coverage:**
- v1 requirements: 35 total
- Mapped to phases: 0
- Unmapped: 35 ⚠️

---
*Requirements defined: 2026-03-23*
*Last updated: 2026-03-23 after initial definition*
