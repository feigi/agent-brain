# Agent Integration Hook Templates

Hook and configuration templates for automating memory workflows with Claude Code and GitHub
Copilot CLI.

These hooks are **optional enhancements**. If you use a different MCP client, rely on the
`memory-guidance` prompt resource's natural-breakpoints pattern instead — it works without any
hook setup.

## Claude Code

### Included Templates

| File                              | Purpose                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| `claude/memory-session-start.sh`  | SessionStart hook that loads memories at session start        |
| `claude/memory-guard.sh`          | PreToolUse hook that blocks writes to Claude Code auto-memory |
| `claude/memory-nudge.sh`          | PostToolUse hook that periodically reminds to save memories   |
| `claude/memory-session-review.sh` | Stop hook that triggers memory review before Claude exits     |
| `claude/settings-snippet.json`    | Hook configuration to merge into `.claude/settings.json`      |

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

| File                              | Purpose                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `copilot/hooks.json`              | Hook configuration template for `.github/hooks/` or `~/.copilot/hooks/`       |
| `copilot/mcp-snippet.json`        | MCP server configuration to merge into `~/.copilot/mcp-config.json`           |
| `copilot/memory-session-start.sh` | sessionStart hook — pre-warms Agent Brain session and creates guard flag      |
| `copilot/memory-session-guard.sh` | **preToolUse hook — blocks all tools until `memory_session_start` is called** |
| `copilot/memory-nudge.sh`         | postToolUse hook — logs tool usage and clears guard flag on success           |
| `copilot/memory-session-end.sh`   | sessionEnd hook that cleans up temp files                                     |

### Prerequisites

- GitHub Copilot CLI (v0.0.422+ for personal hooks support)
- `jq` installed (`brew install jq` on macOS, `apt install jq` on Linux)
- Agent Brain server running (default `http://localhost:19898`, override with `AGENT_BRAIN_URL` env var)

### Key Differences from Claude Code

Copilot CLI hooks have important limitations compared to Claude Code hooks:

| Capability                      | Claude Code                | Copilot CLI                       |
| ------------------------------- | -------------------------- | --------------------------------- |
| Inject context at session start | ✅ via `additionalContext` | ❌ Output ignored                 |
| Block tool execution            | ✅ via `decision: block`   | ✅ via `permissionDecision: deny` |
| Remind agent mid-session        | ✅ via `additionalContext` | ❌ Output ignored                 |
| Block session end for review    | ✅ via `decision: block`   | ❌ Output ignored                 |

Because `preToolUse` with `permissionDecision: deny` is the **only hook output that Copilot CLI
processes**, the `memory-session-guard.sh` hook leverages this to hard-enforce the session start
requirement. All other hooks only perform side-effects (logging, cleanup).

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
cp hooks/copilot/memory-session-guard.sh .github/hooks/
cp hooks/copilot/memory-nudge.sh .github/hooks/
cp hooks/copilot/memory-session-end.sh .github/hooks/
chmod +x .github/hooks/memory-*.sh
```

Copilot CLI automatically loads hooks from `.github/hooks/` in your working directory.

**Option B: Personal hooks** (user-level, all projects)

```bash
mkdir -p ~/.copilot/hooks
cp hooks/copilot/memory-session-start.sh ~/.copilot/hooks/
cp hooks/copilot/memory-session-guard.sh ~/.copilot/hooks/
cp hooks/copilot/memory-nudge.sh ~/.copilot/hooks/
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
        "bash": "$HOME/.copilot/hooks/memory-session-guard.sh",
        "timeoutSec": 5
      }
    ],
    "postToolUse": [
      {
        "type": "command",
        "bash": "$HOME/.copilot/hooks/memory-nudge.sh",
        "timeoutSec": 5
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

#### Session Start + Guard Flag

The `memory-session-start.sh` hook fires when a new session begins. It:

1. Creates a guard flag file `/tmp/copilot-guard-{cwd_hash}` marking that `memory_session_start` has not yet been called
2. Pre-warms the Agent Brain server via its REST API

#### Pre-Tool-Use Guard (hard enforcement)

The `memory-session-guard.sh` hook fires before **every** tool call. It:

1. Checks for the guard flag
2. If the flag exists and the tool is not `memory_session_start` → returns `permissionDecision: deny` with a clear reason message
3. The agent sees the denial and **must** call `memory_session_start` to unblock itself

This is the only Copilot CLI hook output the agent receives, making it the enforcement layer.

#### Post-Tool-Use (flag cleanup)

The `memory-nudge.sh` hook fires after each tool call. When it detects that `memory_session_start`
completed successfully, it removes the guard flag, allowing all subsequent tool calls to proceed
normally.

#### Session End

The `memory-session-end.sh` hook fires when the session ends. It cleans up temp files (session
ID, nudge counter) created during the session.

---

## Troubleshooting

**Hook not firing:** Check that the script is executable (`ls -la .github/hooks/`) and that
the path in the hooks config matches the actual script location.

**`jq: command not found`:** Install jq (see Prerequisites above).

**Claude Code: Claude loops and never stops:** The `stop_hook_active` check should prevent this.
If it happens, check that your `jq` version supports the `// "false"` default syntax (jq 1.5+).

**Copilot CLI: Hooks not loading:** Ensure `hooks.json` is in `.github/hooks/` (repo-level) or
`~/.copilot/hooks/` (personal). The file must have `"version": 1` at the top level.

**Copilot CLI: Guard blocks tools even after calling memory_session_start:** The guard flag is
keyed by CWD hash. Ensure `jq` and `sha256sum` are available. On macOS, `sha256sum` comes from
`coreutils` (`brew install coreutils`); if unavailable, the fallback key `"default"` is used.

## Notes

- Claude Code hooks are configured per-project in `.claude/settings.json`.
- Copilot CLI hooks are loaded from `.github/hooks/` in the working directory or `~/.copilot/hooks/` for personal use.
- The `memory-guidance` prompt resource works for all MCP clients regardless of hook support.
- The Stop/session-end hooks have a 10-second timeout. Memory review calls to the MCP server
  should complete well within this window.
