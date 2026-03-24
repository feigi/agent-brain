# Agent-Brain as Sole Memory System for Claude Code

**Date:** 2026-03-24
**Status:** Draft
**Approach:** Instruction Override + Guard Hook (Approach B)

## Problem

Claude Code has a built-in file-based auto-memory system (`~/.claude/projects/**/memory/`). Agent-brain is an MCP-based memory server with richer capabilities (semantic search, team visibility, types, tags, verification, write budgets). Both systems compete for the same role: persistent memory across sessions.

Currently there are three competing memory targets with no routing rule:
1. Claude Code's system prompt says write to file-based auto-memory
2. MEMORY.md header says "don't save here, use obsidian skills"
3. CLAUDE.md + stop hook say use `memory_create` (agent-brain MCP)

This causes confusion, inconsistent behavior, and occasional rogue writes.

## Goal

Make agent-brain the sole memory system for all projects. Claude Code's file-based auto-memory becomes inert. No memory data is written to the filesystem — all memory operations go through agent-brain MCP tools.

## Design

### Architecture

Four components enforce the replacement:

```
Session Start                 During Session                 Session End
─────────────                 ──────────────                 ───────────
SessionStart hook             CLAUDE.md instructs:           Stop hook prompts
loads memories from           "use agent-brain MCP"          session-end review
agent-brain into                                             via memory_create
additionalContext             PreToolUse guard hook
                              blocks writes to
                              ~/.claude/**/memory/

                              MEMORY.md stub reinforces:
                              "memories live in agent-brain"
```

Three layers say the same thing (CLAUDE.md instructions, guard hook enforcement, MEMORY.md stub). The guard hook is the hard guardrail — even if the model ignores instructions, it physically cannot write to auto-memory.

### Component 1: Global CLAUDE.md Memory Instructions

Replace the "Agent Memory" section in `~/.claude/CLAUDE.md` with instructions that explicitly override auto-memory behavior.

Key additions:
- "Do NOT use Claude Code's built-in file-based auto-memory system (`~/.claude/projects/**/memory/`)"
- "All memory operations go through agent-brain MCP tools"
- "Never write to MEMORY.md or create files in the memory/ directory"
- Presentation format: number memories, include author, date, title, type, and scope

The existing tool documentation (memory_search, memory_create, etc.), identity parameters, and usage guidelines remain. The "When the User Shares Important Context" section remains unchanged.

#### Replacement Content

```markdown
## Memory System

This user uses **agent-brain** (MCP server) as their sole memory system across all projects. Do NOT use Claude Code's built-in file-based auto-memory system (`~/.claude/projects/**/memory/`). All memory operations go through agent-brain MCP tools.

**Reading memory:** Relevant memories are loaded automatically at session start via the SessionStart hook. Use `memory_search` for additional lookups during the session.

**Writing memory:** Use `memory_create` to save learnings, decisions, conventions, and patterns. Never write to MEMORY.md or create files in the memory/ directory.

### Available Tools

- **memory_search** -- Search for relevant memories. Call with a query describing what you need.
- **memory_create** -- Save a new memory from important context the user shares.
- **memory_get** -- Read a specific memory by ID.
- **memory_update** -- Modify an existing memory.
- **memory_comment** -- Append a comment to an existing memory (turns it into a thread).
- **memory_verify** -- Confirm a memory is still accurate (updates verified_at).
- **memory_archive** -- Archive a memory that is no longer relevant.
- **memory_list_stale** -- List memories that need review (old or unverified).

### Identity Parameters

- **`user_id`**: The OS username, i.e. the output of `whoami`. This is the user's identity across all memory tools.
- **`project_id`**: The repository directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

### When to Call `memory_search`

**Call `memory_search` before actions that affect shared systems.** This includes:
1. **The user asks about notes, context, or team knowledge** -- e.g. "any notes?", "what should I know?"
2. **Before actions that affect shared infrastructure** -- deploys, database migrations, credential rotation, etc.
3. **Before running shared/integration tests** (e.g. E2E, load tests) -- but NOT local unit tests or builds

**Do NOT search for purely local actions** like editing files, installing dependencies, running local builds, linting, or formatting.

### When the User Shares Important Context

If the user mentions decisions, temporary changes, or gotchas that the team should know about, suggest saving a memory with `memory_create`. Always confirm before saving.

### Presenting Memories

Always **number** memories and include **author**, **date**, **title**, **type**, and **scope**. The user may refer to memories by number (e.g. "archive memory 2", "comment on 1").
```

### Component 2: PreToolUse Guard Hook

A new hook script that blocks Write/Edit calls targeting the auto-memory directory. Returns a block decision with guidance to use agent-brain instead.

**File:** `hooks/memory-guard.sh` (in agent-brain repo, copied to `~/.claude/hooks/` on install)

```bash
#!/bin/bash
# PreToolUse hook: Block writes to Claude Code's file-based auto-memory.
# Redirects the model to use agent-brain MCP tools instead.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // ""')

# Block writes targeting Claude Code auto-memory paths
if [[ "$FILE_PATH" == */.claude/*/memory/* ]] || [[ "$FILE_PATH" == */.claude/*/memory.md ]]; then
  cat <<'EOF'
{"decision":"block","reason":"Do not write to Claude Code's file-based memory. Use agent-brain MCP tools instead: memory_create to save new memories, memory_update to modify existing ones."}
EOF
  exit 0
fi

# Allow all other writes
exit 0
```

**Hook configuration** (in `~/.claude/settings.json`):

```json
{
  "matcher": "Write|Edit",
  "hooks": [
    {
      "type": "command",
      "command": "/Users/chris/.claude/hooks/memory-guard.sh",
      "timeout": 5
    }
  ]
}
```

This replaces the existing PostToolUse `memory-md-guard.sh` hook, which took a weaker approach (prepending a warning after writes instead of blocking them).

### Component 3: Session-Start Hook Fix

Remove the CWD filter from `hooks/memory-session-start.sh` that restricts it to the agent-brain project only.

**Delete lines 8-11:**

```bash
# Only trigger for the agent-brain project
if [[ "$CWD" != */agent-brain* ]]; then
  exit 0
fi
```

No other changes needed. The hook already derives `project_id` from the directory name and `user_id` from `whoami`. For projects with no agent-brain memories, `memory_session_start` returns an empty result and the hook outputs nothing.

### Component 4: MEMORY.md Stub

Replace the current MEMORY.md content with a minimal redirect notice:

```markdown
# Memory

This project uses agent-brain for memory management. Do not write to this
file or create files in this directory.

Use agent-brain MCP tools: memory_create, memory_search, memory_update.
```

This stub only needs to exist for the current project. For other projects, either:
- The stub is created as part of onboarding
- The guard hook blocks the first auto-memory write and the model self-corrects

Do not pre-seed stubs across all project memory directories.

### Component 5: Settings Configuration Update

Update `hooks/settings-snippet.json` to include all three hooks (for onboarding reference):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/memory-session-start.sh",
            "statusMessage": "Loading memories..."
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/memory-guard.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/memory-session-review.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Change List

### Files to Modify

| File | Change |
|------|--------|
| `hooks/memory-session-start.sh` | Delete CWD filter (lines 8-11) |
| `hooks/settings-snippet.json` | Replace with full three-hook config |
| `~/.claude/CLAUDE.md` | Replace "Agent Memory" section with "Memory System" section |
| `~/.claude/projects/-Users-chris-dev-agent-brain/memory/MEMORY.md` | Replace with stub |
| `~/.claude/settings.json` | Remove PostToolUse `memory-md-guard.sh`, add PreToolUse `memory-guard.sh` |

### Files to Create

| File | Purpose |
|------|---------|
| `hooks/memory-guard.sh` | PreToolUse hook — blocks writes to auto-memory directory |

### Files to Delete

| File | Reason |
|------|--------|
| `~/.claude/projects/-Users-chris-dev-agent-brain/memory/project_ollama_setup.md` | Content already exists in agent-brain |
| `~/.claude/projects/-Users-chris-dev-agent-brain/memory/feedback_memory_display.md` | Content becomes a CLAUDE.md instruction |
| `~/.claude/hooks/memory-md-guard.sh` | Replaced by PreToolUse guard hook |

## Onboarding (New Team Members)

Manual process for now. Automation deferred until team grows.

1. Start agent-brain services: `docker compose up -d`
2. Copy hook scripts to `~/.claude/hooks/`:
   - `memory-session-start.sh`
   - `memory-session-review.sh`
   - `memory-guard.sh`
3. Add hook entries to `~/.claude/settings.json` (reference `hooks/settings-snippet.json`)
4. Add the "Memory System" section to `~/.claude/CLAUDE.md`
5. Current project's MEMORY.md will be handled by the guard hook on first attempted write

## Scope & Non-Goals

- **In scope:** Claude Code CLI integration for all projects
- **In scope:** Shipping hook templates and config snippets in the agent-brain repo
- **Not in scope:** Claude Desktop integration (separate config path via personal preferences + MCP server config)
- **Not in scope:** Automated install script (manual onboarding is sufficient for now)
- **Not in scope:** Migrating existing auto-memory files from other projects (guard hook prevents new writes; old files are harmless)

## Risks

| Risk | Mitigation |
|------|------------|
| Model ignores CLAUDE.md under context compression | Guard hook blocks writes regardless of instruction compliance |
| Guard hook regex misses an auto-memory path variant | Pattern matches both `*/.claude/*/memory/*` and `*/.claude/*/memory.md` — covers known Claude Code paths |
| Session-start hook fails for projects without agent-brain data | `memory_session_start` returns empty result gracefully; hook outputs nothing |
| Agent-brain MCP server not running | Session-start hook fails silently (stderr suppressed); model falls back to session-only context. Stop hook still prompts but memory_create calls fail — acceptable degradation |
