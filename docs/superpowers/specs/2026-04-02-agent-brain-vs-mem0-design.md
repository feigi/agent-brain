# Agent-Brain vs mem0: Comparison Design

## Purpose

A decision document to evaluate whether to adopt mem0, wrap it, or continue
building agent-brain — with maintenance burden as a key factor.

## Audience

The author/maintainer of agent-brain, who received a recommendation to look at
mem0 and wants to validate whether it's worth switching.

## Scope

- Self-hosted mem0 only (managed platform excluded)
- Programming language choice excluded
- Privacy/data sovereignty excluded (both are self-hosted)

## Non-Functional Priorities

- Operational complexity
- Performance
- Extensibility
- Community/longevity
- Maintenance burden (primary concern)

## Research Protocol

All factual claims must be verified against primary sources during writing.
The section descriptions below define _what to investigate_, not _what is true_.
Verify against: the agent-brain codebase (local), the mem0 GitHub repository,
and mem0 documentation.

## Document Structure

### 1. Introduction

Brief framing: what's being compared, why, and what's out of scope. Sets the
lens — this is a maintenance-burden-aware evaluation, not a feature shootout.

### 2. Agent-Brain

Narrative deep-dive. Investigate and describe from primary sources:

- **Core model**: How memories are created, structured, and stored. The role
  (or absence) of LLMs in the write path.
- **Search & retrieval**: What search mechanisms exist, how results are ranked,
  what indexing strategy is used.
- **LLM integration**: Which AI/ML capabilities are used and where. What the
  system delegates to the calling agent vs. handles itself.
- **Deployment & ops**: Infrastructure requirements, deployment options,
  monitoring capabilities, stateful vs. stateless architecture.
- **Multi-user support**: Scoping mechanisms, access control model, tenancy.
- **Memory lifecycle**: How memories age, get verified, deduplicated, archived.
  Budget/rate-limiting mechanisms.
- **Collaboration**: Features for multi-user or multi-agent interaction with
  the same memory store.
- **Extensibility**: How to add new backends, customize behavior, integrate
  with agent tooling.
- **Community**: Project size, contributor base, maintenance model.
- **Maintenance surface**: Dependencies, complexity, how much you own.

### 3. mem0

Narrative deep-dive. Investigate and describe from primary sources (GitHub repo,
docs). Self-hosted only.

- **Core model**: How memories are created, structured, and stored. The role of
  LLMs in the write path. The optional graph layer.
- **Search & retrieval**: Vector search, graph-based retrieval, hybrid
  strategies, reranking, metadata filtering.
- **LLM integration**: Which operations require LLM calls, how many per
  operation, which providers are supported.
- **Deployment & ops**: Infrastructure requirements for minimal vs.
  full-featured self-hosted setups. Monitoring, health checks, scaling
  characteristics. History storage architecture.
- **Multi-user support**: Scoping mechanisms (user, agent, run, etc.), tenancy
  model in core vs. OpenMemory layer.
- **Memory lifecycle**: Deduplication strategy, conflict resolution, event
  history, archival capabilities, staleness handling.
- **Collaboration**: Multi-user or multi-agent features (or lack thereof).
- **Extensibility**: Custom prompts, pluggable backends, plugin architecture,
  adapter ecosystem.
- **Community**: Project size, contributor base, release cadence, ecosystem.
- **Maintenance surface**: What you depend on vs. what you own. Complexity of
  the dependency.

### 4. Gap Analysis

Organized by theme, not as a flat list. Each gap discussed narratively with
an assessment of how much the gap matters for the agent memory use case:

- **Graph memory**: Does mem0's knowledge graph solve a real retrieval problem,
  or add complexity?
- **LLM-driven extraction**: Automatic fact distillation vs. explicit saves.
  Trade-offs: intelligence vs. control, latency, cost.
- **Memory lifecycle**: Explicit lifecycle management vs. implicit LLM
  curation. Which gaps matter in practice?
- **Team collaboration**: Comment threads, verification, activity awareness —
  does one system serve multi-agent use cases better?
- **Backend ecosystem**: Breadth of integrations vs. simplicity. When does
  backend flexibility actually matter?
- **Search sophistication**: Reranking, hybrid search, composite scoring —
  different retrieval philosophies and their practical impact.
- **History/audit trail**: Full event history vs. version tracking. When does
  the difference matter?
- **MCP integration**: Native vs. layered MCP support. Practical implications
  for agent tooling.

### 5. Scenarios

Each scenario is a narrative exploration of what the world looks like, not a
pro/con list.

#### Use only mem0

What you gain, what you lose, what you'd need to build on top (or accept the
absence of). The operational reality of running self-hosted mem0.

#### Wrap mem0

Use mem0 as the storage/retrieval engine and build missing features on top.
What each layer handles. Integration complexity and cross-language concerns.

#### Agent-brain only

Continue with agent-brain and selectively port valuable ideas from mem0.
Which capabilities are worth adding, what the effort looks like, what you keep.

### 6. Recommendation

A firm recommendation based on the analysis. This is a decision document, not
an open-ended exploration. The recommendation considers: the fundamental
architectural difference, maintenance burden trade-offs, and which gaps
actually matter for the agent memory use case. Ends with a clear "do this"
and concrete next steps.

## Not Under Consideration

- Programming language choice
- Managed deployment of mem0 (only self-hosted is relevant)
- Migration cost between systems
