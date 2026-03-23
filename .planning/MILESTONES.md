# Milestones

## v1.0 MVP (Shipped: 2026-03-23)

**Phases completed:** 4 phases, 16 plans, 28 tasks

**Key accomplishments:**

- Complete MCP server scaffold: Drizzle+pgvector schema (512d HNSW), 8 memory tools, EmbeddingProvider abstraction (Titan + Mock), and 27 integration tests against real Docker Postgres
- Composite relevance scoring (80% similarity + 15% recency + 5% verification) with over-fetch/re-rank pipeline, cross-scope search, and `memory_session_start` auto-load tool
- Team collaboration: scope-based access control across all tools, threaded comments, staleness/verification tracking, session activity tracking with `memory_list_recent`
- Agent autonomy: session lifecycle with per-session write budgets, semantic dedup guard chain, MCP prompt resource for capture guidance, and Claude Code Stop hook templates for session-end review

---
