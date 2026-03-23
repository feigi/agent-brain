# Roadmap: Agentic Brain

## Overview

Agentic Brain delivers a long-term memory system for AI agents, exposed as an MCP server. The roadmap progresses from a working MCP server with basic memory operations (Phase 1), through retrieval quality improvements and session lifecycle (Phase 2), to team collaboration features (Phase 3), and finally autonomous agent capture (Phase 4). Each phase delivers a coherent, verifiable capability that builds on the previous phase's foundation.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation and Core Memory** - MCP server with save, search, retrieve, and persist memory operations (completed 2026-03-23)
- [ ] **Phase 2: Retrieval Quality and Session Lifecycle** - Enhanced search ranking, recency weighting, and session-start auto-load
- [x] **Phase 3: Team Collaboration** - Multi-user access, threaded comments, provenance, and staleness detection (completed 2026-03-23)
- [ ] **Phase 4: Agent Autonomy** - Autonomous capture, session-end review, write budgets, and deduplication

## Phase Details

### Phase 1: Foundation and Core Memory
**Goal**: Agents can configure the MCP server, save memories, search them by semantic similarity, and find them again across sessions
**Depends on**: Nothing (first phase)
**Requirements**: INFR-01, INFR-02, INFR-03, INFR-04, INFR-05, CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, CORE-06, CORE-07, CORE-08, CORE-09, SCOP-01, SCOP-02, SCOP-04
**Success Criteria** (what must be TRUE):
  1. Agent can connect to the MCP server and see available memory tools listed (save, get, update, archive, search)
  2. Agent can save a memory with content, title, and tags, then retrieve it by ID in a new session
  3. Agent can search memories by natural language query and receive semantically relevant results with scores
  4. Memories are scoped to a project by default; a user-scoped memory is accessible across projects
  5. Switching embedding providers requires only implementing the provider interface and changing configuration -- no data migration needed because raw text and model metadata are stored alongside vectors
**Plans**: 4 plans

Plans:
- [x] 01-01-PLAN.md -- Project scaffold, database schema, Docker, types, and utilities
- [x] 01-02-PLAN.md -- Embedding providers, repository layer, and memory service
- [x] 01-03-PLAN.md -- All 8 MCP tool handlers and server entry point
- [x] 01-04-PLAN.md -- Integration tests, seed script, and end-to-end verification

### Phase 2: Retrieval Quality and Session Lifecycle
**Goal**: Agents get noticeably better search results through relevance scoring and can auto-load relevant memories at session start
**Depends on**: Phase 1
**Requirements**: SCOP-03, RETR-01, RETR-02, RETR-03, RETR-04, RETR-05
**Success Criteria** (what must be TRUE):
  1. Search results are ranked by a composite score combining semantic similarity and recency, not just raw vector distance
  2. Search results include relevance score, creation date, author, and tags in the response
  3. Agent can auto-load the top-N most relevant memories at session start within a configurable limit
  4. Agent can search both project and user memories in a single query and receive unified ranked results
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md -- Scoring functions, MemoryWithRelevance type, and config extension
- [x] 02-02-PLAN.md -- Cross-scope search and composite scoring in search pipeline
- [x] 02-03-PLAN.md -- memory_session_start MCP tool and integration tests

### Phase 3: Team Collaboration
**Goal**: Multiple users share project memories with provenance tracking, threaded discussions, and staleness management
**Depends on**: Phase 2
**Requirements**: TEAM-01, TEAM-02, TEAM-03, TEAM-04, TEAM-05, TEAM-06, TEAM-07
**Success Criteria** (what must be TRUE):
  1. Two different users can both read and write to the same project's memories, and each memory shows who authored it
  2. User can append a comment to an existing memory, creating a threaded discussion that preserves the original content
  3. User can mark a memory as verified (still accurate), and agent can list memories that haven't been verified within a configurable threshold
  4. Authentication identifies which user or agent is performing each operation
**Plans**: 4 plans

Plans:
- [x] 03-01-PLAN.md -- Database schema, type definitions, validation utilities, and repository interfaces
- [x] 03-02-PLAN.md -- Repository comment_count, service-layer access control, and all 9 existing tool retrofits
- [x] 03-03-PLAN.md -- Comment and session repositories, memory_comment tool, memory_list_recent tool, memory_get enhancement
- [x] 03-04-PLAN.md -- Integration and unit tests for access control, comments, team activity, and validation

### Phase 4: Agent Autonomy
**Goal**: Agents autonomously capture insights mid-session and extract learnings at session end, with safeguards against memory bloat
**Depends on**: Phase 3
**Requirements**: AUTO-01, AUTO-02, AUTO-03, AUTO-04, AUTO-05
**Success Criteria** (what must be TRUE):
  1. Agent saves insights during a session without explicit user instruction, guided by system prompt patterns
  2. Agent performs a session-end review that extracts and saves key learnings
  3. Write budget enforces a maximum number of autonomous saves per session, preventing memory bloat
  4. Saving a memory that is semantically near-identical to an existing one is detected and prevented
**Plans**: 4 plans

Plans:
- [x] 04-01-PLAN.md -- Sessions table, config, types, session repository, and session_id generation in session_start
- [x] 04-02-PLAN.md -- MCP prompt resource for memory capture guidance and Claude Code hook templates
- [ ] 04-03-PLAN.md -- Write budget enforcement and semantic duplicate detection in memory_create
- [ ] 04-04-PLAN.md -- Unit and integration tests for session lifecycle, budget, dedup, and prompt resource

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation and Core Memory | 4/4 | Complete   | 2026-03-23 |
| 2. Retrieval Quality and Session Lifecycle | 0/3 | Not started | - |
| 3. Team Collaboration | 5/5 | Complete   | 2026-03-23 |
| 4. Agent Autonomy | 2/4 | In Progress|  |
