# Requirements: Agentic Brain

**Defined:** 2026-03-23
**Core Value:** Agents remember what matters across sessions — no team knowledge is lost because a conversation ended.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Memory Core

- [x] **CORE-01**: User can save a memory with content, optional title, and optional tags via MCP tool
- [x] **CORE-02**: User can retrieve a specific memory by ID via MCP tool
- [x] **CORE-03**: User can update an existing memory's content, title, or tags
- [x] **CORE-04**: User can archive a memory (soft delete, excluded from search but recoverable)
- [x] **CORE-05**: User can search memories by semantic similarity and receive ranked results with relevance scores
- [x] **CORE-06**: User can tag memories with categories (fact, decision, learning, pattern, preference, architecture)
- [x] **CORE-07**: Memories persist across agent sessions in Postgres
- [x] **CORE-08**: Raw text is stored alongside embeddings (enables re-embedding on provider change)
- [x] **CORE-09**: Embedding model metadata is stored with each memory (model name, dimensions)

### Scoping

- [x] **SCOP-01**: Memories are scoped to a project — agents only see memories for their current project
- [x] **SCOP-02**: User-level memories follow the user across all projects
- [x] **SCOP-03**: Agent can search both project and user memories in a single query
- [x] **SCOP-04**: Cross-project memory leakage is prevented at the database level (RLS)

### Retrieval

- [x] **RETR-01**: Semantic search returns memories ranked by vector similarity
- [x] **RETR-02**: Relevance scoring combines semantic similarity with recency weighting
- [x] **RETR-03**: Search results include relevance score, creation date, author, and tags
- [x] **RETR-04**: Agent can auto-load relevant memories at session start based on project context
- [x] **RETR-05**: Session-start loading returns top-N most relevant memories within a configurable limit

### Team Collaboration

- [x] **TEAM-01**: Multiple users can read and write to shared project memories
- [x] **TEAM-02**: Authentication identifies which user/agent is writing memories
- [x] **TEAM-03**: Each memory records its author (provenance tracking)
- [x] **TEAM-04**: User can append a comment to an existing memory (threaded notes)
- [x] **TEAM-05**: Threaded comments preserve the original memory content and add context
- [x] **TEAM-06**: User can verify a memory is still accurate (updates verified_at timestamp)
- [x] **TEAM-07**: Agent can list memories that haven't been verified within a configurable threshold (staleness detection)

### Agent Autonomy

- [x] **AUTO-01**: Agent can autonomously save insights mid-session without explicit user instruction
- [x] **AUTO-02**: System prompt guidance defines what patterns are worth remembering (decisions, conventions, gotchas, architecture)
- [x] **AUTO-03**: Agent can perform session-end review and extract key learnings
- [ ] **AUTO-04**: Write budget limits the number of autonomous saves per session (prevents memory bloat)
- [ ] **AUTO-05**: Duplicate detection prevents saving memories semantically similar to existing ones

### Infrastructure

- [x] **INFR-01**: MCP server exposes all memory operations as tools via stdio transport
- [x] **INFR-02**: Storage layer is abstracted behind an interface (Postgres + pgvector as default implementation)
- [x] **INFR-03**: Embedding provider is abstracted behind an interface (Amazon Titan v2 as default implementation)
- [x] **INFR-04**: Database schema supports pgvector with HNSW indexing for fast similarity search
- [x] **INFR-05**: Database migrations are managed programmatically (Drizzle ORM)

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
| CORE-01 | Phase 1 | Complete |
| CORE-02 | Phase 1 | Complete |
| CORE-03 | Phase 1 | Complete |
| CORE-04 | Phase 1 | Complete |
| CORE-05 | Phase 1 | Complete |
| CORE-06 | Phase 1 | Complete |
| CORE-07 | Phase 1 | Complete |
| CORE-08 | Phase 1 | Complete |
| CORE-09 | Phase 1 | Complete |
| SCOP-01 | Phase 1 | Complete |
| SCOP-02 | Phase 1 | Complete |
| SCOP-03 | Phase 2 | Complete |
| SCOP-04 | Phase 1 | Complete |
| RETR-01 | Phase 2 | Complete |
| RETR-02 | Phase 2 | Complete |
| RETR-03 | Phase 2 | Complete |
| RETR-04 | Phase 2 | Complete |
| RETR-05 | Phase 2 | Complete |
| TEAM-01 | Phase 3 | Complete |
| TEAM-02 | Phase 3 | Complete |
| TEAM-03 | Phase 3 | Complete |
| TEAM-04 | Phase 3 | Complete |
| TEAM-05 | Phase 3 | Complete |
| TEAM-06 | Phase 3 | Complete |
| TEAM-07 | Phase 3 | Complete |
| AUTO-01 | Phase 4 | Complete |
| AUTO-02 | Phase 4 | Complete |
| AUTO-03 | Phase 4 | Complete |
| AUTO-04 | Phase 4 | Pending |
| AUTO-05 | Phase 4 | Pending |
| INFR-01 | Phase 1 | Complete |
| INFR-02 | Phase 1 | Complete |
| INFR-03 | Phase 1 | Complete |
| INFR-04 | Phase 1 | Complete |
| INFR-05 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 35 total
- Mapped to phases: 35
- Unmapped: 0

---
*Requirements defined: 2026-03-23*
*Last updated: 2026-03-23 after roadmap creation*
