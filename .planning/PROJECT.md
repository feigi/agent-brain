# Agentic Brain

## What This Is

A long-term memory system for AI agents. Agents read relevant memories at session start, autonomously write new insights during and after sessions, and team members can manually save context. Exposed as an MCP server so it works with Claude Code, Cursor, and any MCP-compatible agent.

## Core Value

Agents remember what matters across sessions — no team knowledge is lost because a conversation ended.

## Requirements

### Validated

- [x] Two memory scopes: project-level and user-level — Validated in Phase 1
- [x] Abstracted storage layer (Postgres + pgvector default, swappable) — Validated in Phase 1
- [x] Abstracted embedding provider layer — Validated in Phase 1
- [x] MCP server with save, search, and retrieve memory tools — Validated in Phase 1
- [x] Semantic search via vector embeddings (Amazon Titan via Bedrock, provider-swappable) — Validated in Phase 1
- [x] Session-start auto-load of relevant memories — Validated in Phase 2
- [x] Team sharing — multiple users see shared project memories — Validated in Phase 3
- [x] Authentication and authorization for team access — Validated in Phase 3

### Active

- [x] Auto-write: agent autonomously saves insights mid-session — Validated in Phase 4
- [x] System prompt guidance for what's worth remembering — Validated in Phase 4
- [x] Session-end review: agent extracts and saves learnings — Validated in Phase 4
- [x] Manual user saves via MCP tools — Validated in Phase 4

### Out of Scope

- REST API interface — MCP-first for v1, other interfaces later
- Mobile or web UI — agents are the primary consumers
- Real-time sync between agents — eventual consistency is fine
- Local/offline mode — cloud-backed for team access

## Context

- Target agents: Claude Code, Cursor, Copilot, custom agents — anything speaking MCP
- AWS ecosystem: Postgres on RDS, Titan embeddings via Bedrock, IAM for infra auth
- Memory types: facts, decisions, learnings, patterns, user preferences, architectural choices
- Write triggers are layered: agent judgment mid-session + system prompt nudges + session-end review + manual user action
- Storage and embedding providers are abstracted behind interfaces so the system isn't locked to AWS

## Constraints

- **Protocol**: MCP server — primary interface for v1
- **Cloud**: AWS (RDS, Bedrock) — but abstracted so providers are swappable
- **Team**: Must support multiple users on the same project with shared visibility
- **Embedding cost**: Titan at $0.02/1M tokens — effectively free at expected scale

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| MCP as primary interface | Broadest agent compatibility (Claude Code, Cursor, etc.) | — Pending |
| Postgres + pgvector | Proven, single DB for relational + vector data | — Pending |
| Amazon Titan embeddings | Same AWS ecosystem as RDS, cheap, swappable | — Pending |
| Abstracted storage + embedding layers | Avoid vendor lock-in, enable future flexibility | — Pending |
| Two memory scopes (project + user) | Agents need both project context and user-specific knowledge | — Pending |

## Current State

Phase 4 complete — all 4 milestone phases delivered. MCP server is fully featured with session lifecycle, team collaboration, and agent autonomy. 140/140 tests passing.

## Evolution

This document evolves at phase transitions and milestone boundaries.

Last updated: 2026-03-23

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
*Last updated: 2026-03-23 after Phase 3 completion — team collaboration (access control, comments, team activity)*
