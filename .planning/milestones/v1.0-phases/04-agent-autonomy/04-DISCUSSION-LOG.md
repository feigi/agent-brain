# Phase 4: Agent Autonomy - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-23
**Phase:** 04-agent-autonomy
**Areas discussed:** System prompt delivery, Session-end review mechanism, Write budget mechanics, Duplicate detection behavior, Session ID lifecycle

---

## System Prompt Delivery

### Q1: How does the server provide guidance on what's worth remembering?

**Options presented:**

1. MCP prompt resource — server exposes `prompts/memory-guidance`, agents request it
2. MCP resource (read-only doc) — `resources/memory-guidance`, broadly supported
3. Static template in docs — markdown template users paste into agent config
4. Bundled in session_start response — guidance field returned automatically

**Selected:** 1 — MCP prompt resource

**Follow-up:** Claude Code supports MCP prompts, but they're user-selectable templates (not auto-injected). Two options discussed:

1. Prompt resource + session_start guidance (auto + manual)
2. Prompt resource only, document that users add it to their agent config

**Selected:** 2 — Prompt resource only, user configures agent

### Q2: Should guidance be opinionated about memory type priority?

**Options presented:**

- Opinionated (decisions/architecture highest, patterns/preferences secondary)
- Equal priority, agent judges

**Selected:** Equal priority, agent judges

### Q3: Claude Code hooks for enhanced session lifecycle

**User-initiated discussion.** User wanted to explore advantages of Claude Code hooks.

**Discussed:**

- Stop hook for automatic session-end review
- PostToolCall hook for budget tracking visibility
- Hooks as Claude Code-specific optimization layer on top of prompt-only base

**Selected:** Ship both — prompt resource as base, Claude Code hook templates as enhancement. User wants to test what works best.

---

## Session-End Review Mechanism

### Q1: Does AUTO-03 require a new MCP tool?

**Options presented:**

1. New `memory_session_end` tool — server does extraction logic
2. Agent behavior, no new tool — agent uses existing `memory_create` with `source: 'session-review'`
3. Lightweight tool — marks session ended, returns save summary, no extraction

**Selected:** 2 — Agent behavior, no new tool

### Q2: How does the agent know the session has ended?

**Options presented:**

1. User signals it ("wrapping up", "done for now")
2. Natural breakpoints — save at task completion, commits, milestones
3. Hooks (Claude Code specific)
4. Combination of 1 + 2 — breakpoints throughout + final review on user signal

**Selected:** 4 — Combination. Continuous capture pattern. AUTO-01 and AUTO-03 become a continuous pattern rather than two distinct moments.

---

## Write Budget Mechanics

### Q1: Where is the budget enforced and how?

**Options presented:**

1. Server-side — hard reject on budget hit
2. Client-side (guidance only) — agent self-limits
3. Server-side with soft response — tracks saves, returns budget metadata, warns but configurable behavior

**What counts:**

- A: All creates
- B: Only autonomous writes (`agent-auto`, `session-review`)

**Selected:** 3+B — Server-side soft response, only autonomous writes count

### Q2: Default budget and configurability?

**Options presented:**

1. Fixed default (10)
2. Server-level config (env var `WRITE_BUDGET_PER_SESSION=10`)
3. Per-call override on session_start

**Selected:** 2 — Server-level env var

### Q3: Behavior when budget exceeded?

**Options presented:**

1. Warn but still save
2. Soft reject — NOT saved, structured response, agent can force via `source: 'manual'`
3. Hard reject — MCP error

**Selected:** 2 — Soft reject

---

## Duplicate Detection Behavior

### Q1: Similarity threshold?

**Options presented:**

1. Very strict (>0.95) — near-verbatim only
2. Moderate (>0.90) — catches paraphrases
3. Configurable (env var, default 0.90)

**Selected:** Configurable, default 0.90

### Q2: What scope to check against?

**Options presented:**

- A: Same scope only
- B: Both scopes

**Selected:** Asymmetric — project checks against project only; user checks against user + project

### Q3: When to check?

**Options presented:**

- A: All creates
- B: Only autonomous writes

**Selected:** A — All creates. User wants to verify even manual saves don't duplicate.

### Q4: On detection — what happens?

**Options presented:**

1. Soft reject — NOT saved, existing duplicate returned
2. Warn but save
3. Auto-merge

**Selected:** 1 — Soft reject with existing memory returned. User-scope match against project scope communicates "already exists as shared knowledge."

---

## Session ID Lifecycle

### Q1: Who generates the session ID?

**Options presented:**

1. Server generates on `memory_session_start` — agent passes it on subsequent calls
2. Agent generates client-side
3. Server generates but optional — works without it

**Selected:** 1 — Server generates, source of truth

### Q2: Is session_id required on memory_create?

**Options presented:**

1. Required — all creates must have session_id
2. Optional with degraded behavior
3. Optional now, required in v2

**Selected:** Required for autonomous writes (`agent-auto`, `session-review`), optional for manual writes

### Q3: Session TTL?

**Options presented:**

1. Accept — no expiry, budget is lifetime per session_id
2. Reject stale — configurable TTL
3. Reset budget on stale

**Selected:** 1 — No TTL, sessions don't expire
