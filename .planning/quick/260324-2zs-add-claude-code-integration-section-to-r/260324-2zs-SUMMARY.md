---
phase: quick
plan: 260324-2zs
subsystem: documentation
tags: [readme, claude-code, integration, hooks]
dependency_graph:
  requires: []
  provides: [claude-code-integration-docs]
  affects: [README.md]
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified: [README.md]
decisions:
  - Used project's actual MCP tool names (memory_search, memory_create, etc.) in CLAUDE.md snippet
  - Kept CLAUDE.md snippet concise -- omitted min_relevance details and guardrails to avoid overwhelming new users
  - Placed new section as step 5, renumbered MCP Inspector to step 6
metrics:
  duration: 50s
  completed: "2026-03-24T01:12:10Z"
---

# Quick Task 260324-2zs: Add Claude Code Integration Section to README

Added a self-contained "Integrate with Claude Code" section to README.md with a ready-to-paste CLAUDE.md snippet and Stop hook setup instructions.

## What Was Done

### Task 1: Add "Integrating with Claude Code" section to README

**Commit:** 760701d

Inserted a new section 5 ("Integrate with Claude Code") between the existing "Connect to Claude Code" (step 4) and "Use the MCP Inspector" (now step 6). The section contains:

1. **CLAUDE.md snippet** -- A fenced markdown block users can paste into their project's `CLAUDE.md` or `~/.claude/CLAUDE.md`. Uses the project's actual tool names (`memory_search`, `memory_create`, `memory_get`, `memory_update`, `memory_comment`, `memory_verify`, `memory_archive`, `memory_list_stale`). Includes behavioral triggers for when to search, when to save, and how to present memories.

2. **Session-review hook setup** -- Step-by-step instructions to install the Stop hook from `docs/hooks/`, including the `jq` prerequisite, file copy commands, and the `settings.json` configuration block.

**Files modified:** README.md (+80 lines)

## Deviations from Plan

None -- plan executed exactly as written.

## Known Stubs

None.

## Verification Results

| Check | Result |
|-------|--------|
| "Integrate with Claude Code" appears exactly once | PASS |
| memory-session-review referenced | PASS (3 occurrences) |
| Step 6 is MCP Inspector | PASS |
| Uses memory_search (not search_memory) | PASS |
| Uses memory_create (not save_note) | PASS |

## Self-Check: PASSED

- [x] README.md exists and contains new section
- [x] Commit 760701d exists in git log
