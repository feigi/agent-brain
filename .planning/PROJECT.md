# Agentic Brain

## What This Is

A long-term memory system for AI agents, exposed as an MCP server. Agents save memories during sessions, search them by semantic similarity, and auto-load relevant context at session start. Teams share project memories with provenance tracking and threaded discussions. Agents operate autonomously with write budgets and deduplication to prevent memory bloat.

## Core Value

Agents remember what matters across sessions — no team knowledge is lost because a conversation ended.

## Requirements

### Validated

- ✓ Two memory scopes: project-level and user-level — v1.0
- ✓ Abstracted storage layer (Postgres + pgvector default, swappable) — v1.0
- ✓ Abstracted embedding provider layer — v1.0
- ✓ MCP server with save, search, and retrieve memory tools — v1.0
- ✓ Semantic search via vector embeddings (Amazon Titan via Bedrock, provider-swappable) — v1.0
- ✓ Composite relevance scoring (similarity + recency + verification weighting) — v1.0
- ✓ Session-start auto-load of relevant memories — v1.0
- ✓ Team sharing — multiple users see shared project memories — v1.0
- ✓ Authentication and authorization for team access — v1.0
- ✓ Threaded comments on memories — v1.0
- ✓ Staleness detection with configurable verification threshold — v1.0
- ✓ Auto-write: agent autonomously saves insights mid-session — v1.0
- ✓ System prompt guidance for what's worth remembering — v1.0
- ✓ Session-end review: agent extracts and saves learnings — v1.0
- ✓ Write budget per session (prevents memory bloat) — v1.0
- ✓ Semantic deduplication on save — v1.0

### Active

_(None — clean slate for v1.1)_

### Out of Scope

- REST API interface — MCP-first for v1, other interfaces later
- Mobile or web UI — agents are the primary consumers
- Real-time sync between agents — eventual consistency is fine
- Local/offline mode — cloud-backed for team access
- Knowledge graphs — premature at expected scale; semantic search sufficient
- Complex RBAC/ACLs — two scopes with simple access control covers 95% of use cases

## Context

- v1.0 shipped 2026-03-23: 4 phases, 16 plans, ~2,500 LOC TypeScript
- Tech stack: Node.js 22 + TypeScript 5.9, MCP SDK 1.27, Drizzle ORM 0.45, pgvector 0.8, Titan v2 embeddings, Vitest 4
- 140+ tests passing (unit + integration against real Docker Postgres)
- Target agents: Claude Code, Cursor, Copilot, custom agents — anything speaking MCP
- Write triggers layered: agent judgment + system prompt nudges + session-end review + manual user action

## Constraints

- **Protocol**: MCP server — primary interface for v1
- **Cloud**: AWS (RDS, Bedrock) — but abstracted so providers are swappable
- **Team**: Must support multiple users on the same project with shared visibility
- **Embedding cost**: Titan at $0.02/1M tokens — effectively free at expected scale

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| MCP as primary interface | Broadest agent compatibility (Claude Code, Cursor, etc.) | ✓ Good — works with all major agents |
| Postgres + pgvector | Proven, single DB for relational + vector data | ✓ Good — HNSW queries fast, no separate vector DB needed |
| Amazon Titan embeddings | Same AWS ecosystem as RDS, cheap, swappable | ✓ Good — effectively free at expected scale |
| Abstracted storage + embedding layers | Avoid vendor lock-in, enable future flexibility | ✓ Good — swapping providers is a config change |
| Two memory scopes (project + user) | Agents need both project context and user-specific knowledge | ✓ Good — covers all v1 use cases |
| Composite relevance (80/15/5) | Recency and verification signal boost quality | ✓ Good — over-fetch/re-rank pipeline keeps it fast |
| Per-session write budget + dedup | Prevent memory bloat from autonomous agents | ✓ Good — atomic budget increment, no locking required |
| Static MCP prompt resource | Universal guidance across projects, simplicity first | ✓ Good — usable immediately without configuration |
| stdio transport for v1 | Simplest deployment, works with Claude Code directly | ✓ Good — Streamable HTTP deferred to v1.1 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

Last updated: 2026-03-24 after v1.0 milestone completion

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-24 after v1.0 milestone — full feature MCP memory server shipped*
