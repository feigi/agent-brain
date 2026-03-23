# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-03-23
**Phases:** 4 | **Plans:** 16 | **Sessions:** ~1 day (02:11 → 23:49 UTC+1)

### What Was Built

- Full MCP memory server: 8+ tools, Drizzle+pgvector schema with HNSW indexing, EmbeddingProvider abstraction (Titan + Mock)
- Composite relevance retrieval: 80/15/5 scoring (similarity + recency + verification), over-fetch/re-rank, cross-scope search, `memory_session_start` auto-load
- Team collaboration: scope-based access control, threaded comments, staleness detection, team activity tracking
- Agent autonomy: session lifecycle, write budgets with atomic increment, semantic dedup, MCP prompt resource, Claude Code hook templates

### What Worked

- **TDD on scoring functions** — pure functions with deterministic inputs made relevance scoring easy to iterate on before wiring into service layer
- **MockEmbeddingProvider** — deterministic hash-based vectors enabled reliable semantic search tests without hitting Bedrock; clear semantic groupings in test data made ranking assertions trustworthy
- **Layered guard chain pattern** (session → budget → embed → dedup → insert) — fail-fast on cheapest checks before incurring embedding cost; clean, auditable flow
- **Drizzle `sql` escape hatch** — correlated subquery for `comment_count` couldn't be expressed in Drizzle's builder (parameterizes column refs as values); raw SQL string workaround was discovered and documented clearly

### What Was Inefficient

- **Phase 2 progress table not auto-updated** — ROADMAP.md progress table showed Phase 2 as "Not started" even after all summaries existed; required manual fix during milestone completion
- **Phase 4 SUMMARY.md non-standard format** — some Phase 4 summaries had task-level headers instead of phase-level one-liners, causing noisy MILESTONES.md extraction; requires consistent summary format enforcement
- **Audit skipped** — proceeded without `/gsd:audit-milestone` due to high requirements coverage confidence; running the audit would have caught the Phase 2 table discrepancy earlier

### Patterns Established

- **Stderr-only logging** — `console.error()` everywhere, never `console.log()` — MCP stdio transport corrupted by any stdout output
- **Domain error hierarchy** — `DomainError` base with code + statusHint; specialized subclasses prevent leaking internal errors at MCP boundary
- **Test helper pattern** — `createTestService()` wires MockEmbeddingProvider + real DB; `truncateAll()` does FK-safe delete order in `beforeEach`; `fileParallelism: false` for shared Docker Postgres
- **Optional constructor params for backward compat** — new repos/services added as optional positional params (not breaking), preserving existing tests without migration

### Key Lessons

1. **Fix data discrepancies immediately** — stale progress tables compound; update ROADMAP progress rows at the same time summaries are written
2. **Standardize SUMMARY.md one-liner format** — the `**One-liner:**` or `**[bold description]**` pattern should be consistent across ALL plans for reliable extraction; Phase 4 diverged
3. **Cosine distance needs explicit parentheses** — `1 - (embedding <=> $vector)` not `1 - embedding <=> $vector`; operator precedence is a footgun with pgvector
4. **PostgreSQL NOTICE messages corrupt MCP stdio** — suppress with `onnotice: () => {}` on the postgres.js connection; easy to miss, hard to debug when it breaks
5. **Atomic budget increment pattern** — `UPDATE WHERE budget_used < limit RETURNING` avoids application-level locking for write budgets; clean and race-condition-free

### Cost Observations

- Sessions: 1 day, ~16 sequential plan executions
- Notable: All 16 plans completed in a single day — fast execution due to well-scoped phases and clear PLAN.md artifacts

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 1 day | 4 | Initial baseline |

### Cumulative Quality

| Milestone | Tests | Notes |
|-----------|-------|-------|
| v1.0 | 140+ | Unit + integration against real Docker Postgres |

### Top Lessons (Verified Across Milestones)

1. *(Single milestone — trends will emerge with v1.1+)*
