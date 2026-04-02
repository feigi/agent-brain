# Agent-Brain vs mem0 Comparison — Implementation Plan

> **For agentic workers:** This is a research and writing plan, not a code
> implementation plan. Each task produces a section of the comparison document.
> Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to work through tasks sequentially.

**Goal:** Produce a narrative comparison document that supports a decision on
whether to adopt mem0, wrap it, or continue with agent-brain.

**Architecture:** Six sequential writing tasks, each producing one section of
the final document. Each task includes specific research actions (what to read,
what to verify) followed by writing. The document builds cumulatively — later
sections reference earlier ones.

**Spec:** `docs/superpowers/specs/2026-04-02-agent-brain-vs-mem0-design.md`

**Output:** `docs/agent-brain-vs-mem0.md`

---

## Task 1: Introduction

**Files:**

- Create: `docs/agent-brain-vs-mem0.md`

- [ ] **Step 1: Write the introduction section**

Write the opening section of `docs/agent-brain-vs-mem0.md`. Cover:

- What's being compared: agent-brain (custom MCP memory server) vs mem0
  (open-source memory layer for AI agents)
- Why: received a recommendation to evaluate mem0; need to decide whether to
  adopt it, wrap it, or continue with agent-brain
- The decision lens: maintenance burden is the primary concern, followed by
  operational complexity, performance, extensibility, and community health
- What's excluded: programming language choice, managed mem0 platform (only
  self-hosted), privacy/data sovereignty (both self-hosted), migration cost

Tone: direct, concise, no marketing language. This is a personal decision
document, not a blog post.

- [ ] **Step 2: Commit**

```bash
git add docs/agent-brain-vs-mem0.md
git commit -m "docs: add introduction for agent-brain vs mem0 comparison"
```

---

## Task 2: Agent-Brain Deep-Dive

**Files:**

- Modify: `docs/agent-brain-vs-mem0.md`

**Research actions (verify all claims against primary sources):**

- [ ] **Step 1: Investigate core model and search**

Read these files and document findings:

- `src/db/schema.ts` — memory table structure, field types, indexes
- `src/services/memory-service.ts` — how memories are created, the write path
- `src/repositories/memory-repository.ts` — search implementation, ranking
- `src/utils/scoring.ts` — composite scoring algorithm, weight values

Record: exact field names, exact ranking weights, index type, whether any LLM
calls exist in the write path.

- [ ] **Step 2: Investigate LLM integration and deployment**

Read these files and document findings:

- `src/providers/embedding/` — all embedding provider files
- `docker-compose.yml` and `docker-compose.prod.yml` — infrastructure
- `src/server.ts` — transport, stateless vs stateful
- `src/routes/health.ts` — monitoring capabilities
- `Dockerfile` — container setup

Record: which providers exist, what infrastructure is required, how the server
runs, what monitoring exists.

- [ ] **Step 3: Investigate multi-user, lifecycle, and collaboration**

Read these files and document findings:

- `src/tools/memory-verify.ts` — verification workflow
- `src/tools/memory-archive.ts` — archival mechanism
- `src/tools/memory-list-stale.ts` — staleness detection
- `src/tools/memory-comment.ts` — comment/thread system
- `src/tools/memory-list-recent.ts` — activity awareness
- `src/tools/memory-create.ts` — duplicate detection, write budget
- `src/repositories/session-repository.ts` — session/budget tracking
- `src/types/memory.ts` — scope and type enums

Record: exact scoping model, access control rules, lifecycle features,
collaboration features.

- [ ] **Step 4: Investigate extensibility and community**

Run:

- `wc -l src/**/*.ts` — approximate codebase size
- `cat package.json | jq '.dependencies'` — dependency count
- `git log --oneline | head -20` — recent development activity
- `git shortlog -sn` — contributor count

Record: codebase size, dependency footprint, contributor model.

- [ ] **Step 5: Write the Agent-Brain section**

Add the Agent-Brain narrative deep-dive to `docs/agent-brain-vs-mem0.md`.
Cover all 10 themes from the spec using only verified findings from Steps 1-4.
No claims without evidence from the codebase.

Structure as flowing prose under themed subheadings, not bullet lists.

- [ ] **Step 6: Commit**

```bash
git add docs/agent-brain-vs-mem0.md
git commit -m "docs: add agent-brain deep-dive to comparison"
```

---

## Task 3: mem0 Deep-Dive

**Files:**

- Modify: `docs/agent-brain-vs-mem0.md`

**Research actions (verify all claims against primary sources):**

- [ ] **Step 1: Investigate core model and write path**

Read from the mem0 GitHub repository (`mem0ai/mem0`):

- `mem0/memory/main.py` — the `Memory` class, `add()` method, how inferred
  writes work
- `mem0/configs/prompts.py` — fact extraction and update decision prompts
- `mem0/memory/graph_memory.py` — graph layer: entity extraction, relation
  extraction, conflict resolution

Verify: how many LLM calls per inferred write (with and without graph). What
happens when `infer=False`. How memories are structured (MemoryItem fields).

- [ ] **Step 2: Investigate search and retrieval**

Read from the mem0 GitHub repository:

- `mem0/memory/main.py` — `search()` method
- `mem0/memory/graph_memory.py` — graph search path
- `mem0/vector_stores/` — at least 2-3 implementations to understand the
  interface
- Check for reranker implementations

Verify: how vector and graph search combine, what reranking options exist,
what metadata filter operators are supported.

- [ ] **Step 3: Investigate deployment and infrastructure**

Read from the mem0 GitHub repository:

- `server/` directory — REST API server, Docker setup
- `openmemory/` directory — MCP server, Docker Compose, what services are
  required
- `mem0/memory/storage.py` — history store implementation
- `pyproject.toml` or `setup.py` — dependencies

Verify: minimum infrastructure for self-hosted, full-featured infrastructure,
whether SQLite history is pluggable, health check/monitoring capabilities.

- [ ] **Step 4: Investigate multi-user, lifecycle, and extensibility**

Read from the mem0 GitHub repository:

- How `user_id`, `agent_id`, `run_id` are used in `add()` and `search()`
- `mem0/memory/main.py` — deduplication/conflict handling in `add()`
- `openmemory/api/` — additional lifecycle features (archive, categories)
- Configuration options for custom prompts
- `mem0/vector_stores/configs.py` or factory — backend pluggability

Verify: scoping model, what lifecycle features exist in core vs OpenMemory,
how to customize behavior.

- [ ] **Step 5: Investigate community health**

Check via web search or GitHub:

- Star count, fork count, contributor count
- Recent release dates and cadence
- Open issues and PR activity
- License

Record exact numbers with date checked.

- [ ] **Step 6: Write the mem0 section**

Add the mem0 narrative deep-dive to `docs/agent-brain-vs-mem0.md`. Cover all
10 themes from the spec using only verified findings from Steps 1-5. No
claims without evidence from primary sources.

Structure as flowing prose under themed subheadings, matching the Agent-Brain
section structure for easy cross-reference.

- [ ] **Step 7: Commit**

```bash
git add docs/agent-brain-vs-mem0.md
git commit -m "docs: add mem0 deep-dive to comparison"
```

---

## Task 4: Gap Analysis

**Files:**

- Modify: `docs/agent-brain-vs-mem0.md`

**Prerequisite:** Tasks 2 and 3 must be complete. This task references the
verified findings from both deep-dives.

- [ ] **Step 1: Re-read both deep-dive sections**

Read the Agent-Brain and mem0 sections from `docs/agent-brain-vs-mem0.md` to
have both sets of verified facts fresh.

- [ ] **Step 2: Write the gap analysis**

Add the Gap Analysis section to `docs/agent-brain-vs-mem0.md`. Cover each
theme from the spec:

- **Graph memory** — What mem0's graph layer provides, whether agent-brain's
  use case (agent long-term memory, not knowledge base) benefits from it
- **LLM-driven extraction** — The trade-off between automatic fact distillation
  and explicit saves: intelligence vs. control, latency, cost, predictability
- **Memory lifecycle** — Explicit lifecycle (verification, staleness, budgets)
  vs. implicit LLM curation (dedup, conflict resolution). Which gaps matter?
- **Team collaboration** — Comments, verification, activity awareness vs. audit
  log only. Does multi-agent usage need collaboration features?
- **Backend ecosystem** — 27 vector stores vs. pgvector. When does backend
  flexibility actually matter for a self-hosted deployment?
- **Search sophistication** — Reranking, hybrid search vs. composite scoring.
  Practical retrieval quality impact.
- **History/audit trail** — Full event history vs. version tracking
- **MCP integration** — Native vs. layered. Practical implications.

Each gap should include an assessment of how much it matters for the agent
memory use case, not just state the difference.

- [ ] **Step 3: Commit**

```bash
git add docs/agent-brain-vs-mem0.md
git commit -m "docs: add gap analysis to comparison"
```

---

## Task 5: Scenarios

**Files:**

- Modify: `docs/agent-brain-vs-mem0.md`

**Prerequisite:** Task 4 must be complete. Scenarios build on the gap analysis.

- [ ] **Step 1: Re-read the gap analysis section**

Read the Gap Analysis from `docs/agent-brain-vs-mem0.md` to have the assessed
gaps fresh.

- [ ] **Step 2: Write the "Use only mem0" scenario**

Narrative exploration: what the world looks like if you drop agent-brain and
use only self-hosted mem0. What you gain (reference specific gaps where mem0
is stronger). What you lose (reference specific gaps where agent-brain is
stronger). What you'd need to build on top or accept the absence of.
Operational reality: what infrastructure you run, what the day-to-day looks
like.

- [ ] **Step 3: Write the "Wrap mem0" scenario**

Narrative exploration: use mem0 as the storage/retrieval engine, build
agent-brain's missing features on top. What each layer handles. The
integration surface: depending on mem0's internal data model, cross-language
concerns (TypeScript wrapping Python), two runtimes. Whether the wrapper
approach actually reduces maintenance or adds a different kind of complexity.

- [ ] **Step 4: Write the "Agent-brain only" scenario**

Narrative exploration: continue with agent-brain and selectively port ideas
from mem0. For each gap identified in Task 4 where mem0 is stronger, assess:
is it worth porting? What would the effort look like? Concrete candidates to
consider (e.g., event history, graph-like enrichment, reranking, advanced
filters). What you keep by staying on agent-brain. The maintenance trade-off:
you own everything, but it's small and focused.

- [ ] **Step 5: Commit**

```bash
git add docs/agent-brain-vs-mem0.md
git commit -m "docs: add scenarios to comparison"
```

---

## Task 6: Recommendation

**Files:**

- Modify: `docs/agent-brain-vs-mem0.md`

**Prerequisite:** Task 5 must be complete. The recommendation synthesizes
everything.

- [ ] **Step 1: Re-read the full document**

Read all sections of `docs/agent-brain-vs-mem0.md` end to end.

- [ ] **Step 2: Write the recommendation**

A firm recommendation: which scenario to pursue and why. This section must:

- Name one scenario clearly (not hedge between options)
- Ground the recommendation in the analysis (reference specific gaps and their
  assessed importance)
- Address the primary concern: maintenance burden
- Address the secondary concerns: operational complexity, performance,
  extensibility, community
- End with concrete next steps (2-4 specific actions to take)

- [ ] **Step 3: Final read-through**

Read the complete document end to end. Check for:

- Internal consistency (does the recommendation follow from the analysis?)
- Any unverified claims that slipped in
- Tone consistency (direct, concise, personal decision document)
- No marketing language, no hedging, no "it depends"

- [ ] **Step 4: Commit**

```bash
git add docs/agent-brain-vs-mem0.md
git commit -m "docs: add recommendation and finalize comparison"
```
