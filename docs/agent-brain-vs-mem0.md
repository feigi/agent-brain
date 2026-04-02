# agent-brain vs mem0

## Introduction

This document compares [agent-brain](https://github.com/cdrake/agent-brain) (a custom MCP memory server) with [mem0](https://github.com/mem0ai/mem0) (an open-source memory layer for AI agents). The goal is to decide between three options:

1. **Adopt mem0** -- replace agent-brain entirely.
2. **Wrap mem0** -- use mem0 as a backend and build missing features on top.
3. **Continue with agent-brain** -- selectively port good ideas from mem0.

### Why now

Someone recommended evaluating mem0 as an alternative. Rather than dismissing or adopting it reflexively, this document captures a structured comparison to inform the decision.

### Decision criteria

The criteria, in priority order:

1. **Maintenance burden** -- How much ongoing work does each option require? This is the primary concern. A solo maintainer cannot absorb unbounded maintenance cost.
2. **Operational complexity** -- What does deployment, monitoring, and day-to-day operation look like?
3. **Performance** -- Latency and resource consumption for typical workloads (memory creation, search, retrieval).
4. **Extensibility** -- How easy is it to add new capabilities (e.g., new memory types, integrations, storage backends)?
5. **Community health** -- Contributor activity, issue response times, release cadence, bus factor.

### Out of scope

The following are explicitly excluded from this comparison:

- **Programming language choice** -- Not a deciding factor; both projects work regardless of language preference.
- **mem0 managed platform** -- Only self-hosted deployment is relevant here.
- **Privacy and data sovereignty** -- Both options are self-hosted, so data stays local in either case.
- **Migration cost** -- This is a one-time cost and should not drive the long-term architectural decision.
