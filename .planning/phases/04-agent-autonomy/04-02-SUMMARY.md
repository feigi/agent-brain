---
phase: 04-agent-autonomy
plan: "02"
subsystem: prompts-and-hooks
tags: [mcp-prompt, memory-guidance, claude-code-hooks, session-review, stop-hook]
dependency_graph:
  requires: []
  provides: [memory-guidance-prompt, session-review-hooks]
  affects: [src/server.ts]
tech_stack:
  added: []
  patterns: [mcp-registerPrompt, claude-code-stop-hook, infinite-loop-prevention]
key_files:
  created:
    - src/prompts/memory-guidance.ts
    - docs/hooks/memory-session-review.sh
    - docs/hooks/settings-snippet.json
    - docs/hooks/README.md
  modified:
    - src/server.ts
decisions:
  - Static prompt guidance with no arguments (per research Open Question 3 recommendation -- simplicity first)
  - Hook script uses jq with default fallback (.stop_hook_active // "false") to safely handle missing field
  - source 'manual' bypasses budget limit and is called out explicitly in prompt guidance text
metrics:
  duration: "2min"
  completed: "2026-03-23"
  tasks_completed: 2
  files_changed: 5
---

# Phase 4 Plan 2: MCP Prompt Resource and Claude Code Hook Templates Summary

**One-liner:** MCP `memory-guidance` prompt resource with comprehensive capture guidance and Claude Code Stop hook templates with infinite-loop prevention for session-end review.

## What Was Built

### Task 1: MCP Prompt Resource (`5aa8aa3`)

Created `src/prompts/memory-guidance.ts` with `registerMemoryGuidance()` that registers a static
`memory-guidance` prompt resource via the MCP SDK. The prompt content covers:

- **What to Capture** — all 6 memory types at equal priority: decisions, conventions, gotchas, architecture, patterns, preferences (per D-03)
- **When to Save** — natural breakpoints: after tasks, commits, surprising discoveries, bug resolutions, user context sharing (per D-05)
- **When NOT to Save** — trivial facts, temporary debugging, already-captured info, non-generalizable details
- **Session-End Review** — review work at session end, use `source: 'session-review'` for end-of-session saves (per D-04/D-05)
- **Budget Awareness** — 10-write default limit per session, `source: 'manual'` bypasses budget for critical saves (per D-13)

Updated `src/server.ts` to import and call `registerMemoryGuidance(server)` after `registerAllTools`.

### Task 2: Claude Code Hook Templates (`db8e3cd`)

Created three files in `docs/hooks/`:

- **`memory-session-review.sh`** — Stop hook script that blocks Claude's first stop attempt and requests a session-end memory review. Checks `stop_hook_active` to prevent infinite loops (Pitfall 2 from research).
- **`settings-snippet.json`** — Ready-to-use hook configuration for `.claude/settings.json` with `Stop` hook pointing to the script.
- **`README.md`** — Setup instructions covering prerequisites (jq), installation steps, how it works, infinite-loop prevention explanation, and troubleshooting.

Hooks are documented as optional enhancements for Claude Code users (per D-09).

## Decisions Made

1. **Static prompt with no arguments** — Per research recommendation (Open Question 3): start with zero arguments for simplicity. Guidance is universal across projects. Optional `context` arg can be added later if needed.

2. **jq default fallback for stop_hook_active** — Used `.stop_hook_active // "false"` in jq to safely handle hook input JSON that doesn't have this field, preventing script failures on older Claude Code versions.

3. **source: 'manual' callout in prompt** — Explicitly mentioned in the Budget Awareness section so agents know how to force-save critical information when budget is exceeded (per D-13).

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all files contain complete, working content.

## Self-Check: PASSED

Files created:
- `src/prompts/memory-guidance.ts` — FOUND
- `docs/hooks/memory-session-review.sh` — FOUND
- `docs/hooks/settings-snippet.json` — FOUND
- `docs/hooks/README.md` — FOUND

Modified files:
- `src/server.ts` — FOUND (contains `registerMemoryGuidance`)

Commits:
- `5aa8aa3` — feat(04-02): add MCP prompt resource for memory capture guidance
- `db8e3cd` — feat(04-02): add Claude Code hook templates for session-end review
