# Agent Integration Hook Templates

> **Fast path:** from a cloned checkout, run `npm run install:agent` to install hooks, MCP config, and instructions for Claude Code or Copilot CLI in one step. Uninstall with `npm run uninstall:agent`. The manual steps below remain for reference and for users who prefer fine-grained control.

Hook and configuration templates for automating memory workflows with Claude Code and GitHub
Copilot CLI.

These hooks are **optional enhancements**. If you use a different MCP client, rely on the
`memory-guidance` prompt resource's natural-breakpoints pattern instead — it works without any
hook setup.

## Claude Code

### Included Templates

| File                              | Purpose                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `claude/memory-session-start.sh`  | SessionStart hook that loads memories at session start                     |
| `claude/memory-guard.sh`          | PreToolUse hook that blocks writes to Claude Code auto-memory              |
| `claude/memory-autofill.sh`       | PreToolUse hook that auto-fills `user_id`/`workspace_id` on MCP tool calls |
| `claude/memory-nudge.sh`          | PostToolUse hook that periodically reminds to save memories                |
| `claude/memory-session-review.sh` | Stop hook that triggers memory review before Claude exits                  |
| `claude/settings-snippet.json`    | Hook configuration to merge into `.claude/settings.json`                   |

### Prerequisites

- Claude Code with hooks support (available in recent Claude Code versions)
- `jq` installed (used by the hook script to parse the hook input JSON)
  - macOS: `brew install jq`
  - Linux: `apt install jq` or `yum install jq`

### Installation

#### Step 1: Copy the hook scripts

```bash
mkdir -p ~/.claude/hooks
cp hooks/claude/memory-session-start.sh ~/.claude/hooks/
cp hooks/claude/memory-guard.sh ~/.claude/hooks/
cp hooks/claude/memory-autofill.sh ~/.claude/hooks/
cp hooks/claude/memory-nudge.sh ~/.claude/hooks/
cp hooks/claude/memory-session-review.sh ~/.claude/hooks/
```

#### Step 2: Make them executable

```bash
chmod +x ~/.claude/hooks/memory-*.sh
```

#### Step 3: Add the Stop hook configuration

Open (or create) `.claude/settings.json` in your project and add the Stop hook configuration
from `hooks/claude/settings-snippet.json`. Your settings file should contain:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-session-review.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

If you already have hooks configured, merge this Stop hook array into your existing settings.

### How It Works

#### ID Autofill (PreToolUse)

The autofill hook matches `mcp__agent-brain__.*` and rewrites `tool_input` via
`hookSpecificOutput.updatedInput` to populate `user_id` (from `whoami`) and `workspace_id`
(from `basename $cwd`) when missing. This prevents the model from guessing identity values.

#### Memory Nudge (PostToolUse)

The nudge hook fires after every tool call but only emits a reminder every 20 calls. It uses a
temp file counter (`/tmp/claude-memory-nudge-{session}`) to track invocations. The reminder is
injected as `additionalContext` — visible to Claude but not the user — prompting it to consider
saving any decisions, conventions, or preferences shared during the session.

#### Session Review (Stop)

1. Claude Code fires the Stop hook when Claude is about to stop responding.
2. The hook script reads the hook input JSON from stdin and checks the `stop_hook_active` field.
3. **First stop attempt** (`stop_hook_active` is not set or false): The hook outputs a `"decision": "block"` response that prevents Claude from stopping and asks it to perform a session-end memory review.
4. **Second stop attempt** (`stop_hook_active` is true): The hook exits with code 0, allowing Claude to stop normally.

This prevents the infinite loop where blocking the stop would trigger another stop, which would
trigger the hook again, forever.

### Infinite Loop Prevention

The `stop_hook_active` check is critical. Claude Code sets this field to `true` when Claude is
attempting to stop inside a hook context. Without this check, the hook would block every stop
attempt, trapping Claude in an endless review cycle.

The script checks:

```bash
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // "false"')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0  # Let Claude stop
fi
```

---

## GitHub Copilot CLI

### Included Templates

| File                              | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `copilot/hooks.json`              | Hook configuration template for `.github/hooks/` or `~/.copilot/hooks/` |
| `copilot/mcp-snippet.json`        | MCP server configuration to merge into `~/.copilot/mcp-config.json`     |
| `copilot/memory-session-start.sh` | sessionStart hook — loads memories and injects as `additionalContext`   |
| `copilot/memory-pretool.sh`       | preToolUse hook — auto-fills IDs and emits periodic save-memories nudge |
| `copilot/memory-session-end.sh`   | sessionEnd hook that cleans up temp files                               |

### Prerequisites

- GitHub Copilot CLI **v1.0.24+** — the minimum version for the full template set.
  The templates rely on three capabilities that landed across these releases:
  - v1.0.11+ — `sessionStart` honors `additionalContext` output ([issue #2142](https://github.com/github/copilot-cli/issues/2142))
  - v1.0.22+ — `sessionStart`/`sessionEnd` fire once per session in interactive mode
  - v1.0.24+ — `preToolUse` honors `modifiedArgs` and `additionalContext`
- `jq` installed (`brew install jq` on macOS, `apt install jq` on Linux)
- Agent Brain server running (default `http://localhost:19898`, override with `AGENT_BRAIN_URL` env var)

### Parity with Claude Code

With Copilot CLI v1.0.24+, both `sessionStart` and `preToolUse` outputs are honored for
context injection and tool input mutation. This closes most of the former feature gap:

| Capability                      | Claude Code              | Copilot CLI                                  |
| ------------------------------- | ------------------------ | -------------------------------------------- |
| Inject context at session start | ✅ via SessionStart      | ✅ via `sessionStart` (v1.0.11+)             |
| Auto-fill MCP tool args         | ✅ via `updatedInput`    | ✅ via `modifiedArgs` (v1.0.24+)             |
| Remind agent mid-session        | ✅ via PostToolUse       | ✅ via `preToolUse` every N calls (v1.0.24+) |
| Block tool execution            | ✅ via `decision: block` | ⚠️ supported but not used in these templates |
| Block session end for review    | ✅ via Stop              | ❌ no equivalent `sessionEnd` blocking       |

Session-end blocking (to force a review before the agent stops) has no Copilot equivalent yet —
custom instructions cover that case on a best-effort basis.

### Installation

#### Step 1: Add the MCP server

Merge the contents of `hooks/copilot/mcp-snippet.json` into your `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "agent-brain": {
      "type": "http",
      "url": "http://localhost:19898/mcp"
    }
  }
}
```

#### Step 2: Copy hook scripts and configuration

**Option A: Repository-level hooks** (recommended for teams)

Copy the hook scripts and configuration into your project's `.github/hooks/` directory:

```bash
mkdir -p .github/hooks
cp hooks/copilot/hooks.json .github/hooks/hooks.json
cp hooks/copilot/memory-session-start.sh .github/hooks/
cp hooks/copilot/memory-pretool.sh .github/hooks/
cp hooks/copilot/memory-session-end.sh .github/hooks/
chmod +x .github/hooks/memory-*.sh
```

Copilot CLI automatically loads hooks from `.github/hooks/` in your working directory.

**Option B: Personal hooks** (user-level, all projects)

```bash
mkdir -p ~/.copilot/hooks
cp hooks/copilot/memory-session-start.sh ~/.copilot/hooks/
cp hooks/copilot/memory-pretool.sh ~/.copilot/hooks/
cp hooks/copilot/memory-session-end.sh ~/.copilot/hooks/
chmod +x ~/.copilot/hooks/memory-*.sh
```

Then create `~/.copilot/hooks/hooks.json` with absolute paths:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "$HOME/.copilot/hooks/memory-session-start.sh",
        "timeoutSec": 10
      }
    ],
    "preToolUse": [
      {
        "type": "command",
        "bash": "$HOME/.copilot/hooks/memory-pretool.sh",
        "timeoutSec": 10
      }
    ],
    "sessionEnd": [
      {
        "type": "command",
        "bash": "$HOME/.copilot/hooks/memory-session-end.sh",
        "timeoutSec": 5
      }
    ]
  }
}
```

#### Step 3: Add custom instructions

Create or verify `.github/copilot-instructions.md` in your project root (or
`~/.copilot/copilot-instructions.md` for personal use). A ready-to-use instructions snippet
is at `hooks/copilot/instructions-snippet.md`.

### How It Works

#### Session Start

The `memory-session-start.sh` hook fires once when a new Copilot CLI session begins. It calls
`memory_session_start` on the Agent Brain server and emits the response as `additionalContext`
so the agent has recent memories available before its first tool call. If the server is
unreachable the hook exits silently and the session proceeds without memories.

#### Pre-Tool-Use (memory-pretool.sh)

The `preToolUse` hook runs on every tool invocation. It does two things:

1. **Every 20 calls** — emits a save-memories reminder as `additionalContext`.
2. **On `mcp__agent-brain__*` tool calls** — fills missing `user_id` and `workspace_id` in
   `tool_input` via `modifiedArgs`. Uses `whoami` and `basename $cwd` as canonical values so
   the agent can't guess wrong casing.

If neither applies the hook emits no output and the tool call proceeds unchanged.

#### Session End

The `memory-session-end.sh` hook fires when the session ends. It cleans up temp files (the
session ID stash and the nudge counter) created during the session.

---

## Troubleshooting

**Hook not firing:** Check that the script is executable (`ls -la .github/hooks/`) and that
the path in the hooks config matches the actual script location.

**`jq: command not found`:** Install jq (see Prerequisites above).

**Claude Code: Claude loops and never stops:** The `stop_hook_active` check should prevent this.
If it happens, check that your `jq` version supports the `// "false"` default syntax (jq 1.5+).

**Copilot CLI: Hooks not loading:** Ensure `hooks.json` is in `.github/hooks/` (repo-level) or
`~/.copilot/hooks/` (personal). The file must have `"version": 1` at the top level.

## Notes

- Claude Code hooks are configured per-project in `.claude/settings.json`.
- Copilot CLI hooks are loaded from `.github/hooks/` in the working directory or `~/.copilot/hooks/` for personal use.
- The `memory-guidance` prompt resource works for all MCP clients regardless of hook support.
- The Stop/session-end hooks have a 10-second timeout. Memory review calls to the MCP server
  should complete well within this window.
