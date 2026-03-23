# Claude Code Hook Templates

Hook templates for automating session-end memory review with Claude Code.

These hooks are **optional enhancements** for Claude Code users. If you use a different MCP client,
rely on the `memory-guidance` prompt resource's natural-breakpoints pattern instead -- it works
without any hook setup.

## Included Templates

| File | Purpose |
|------|---------|
| `memory-session-review.sh` | Stop hook that triggers memory review before Claude exits |
| `settings-snippet.json` | Hook configuration to merge into `.claude/settings.json` |

## Prerequisites

- Claude Code with hooks support (available in recent Claude Code versions)
- `jq` installed (used by the hook script to parse the hook input JSON)
  - macOS: `brew install jq`
  - Linux: `apt install jq` or `yum install jq`

## Installation

### Step 1: Copy the hook script

```bash
mkdir -p .claude/hooks
cp docs/hooks/memory-session-review.sh .claude/hooks/
```

### Step 2: Make it executable

```bash
chmod +x .claude/hooks/memory-session-review.sh
```

### Step 3: Add the Stop hook configuration

Open (or create) `.claude/settings.json` in your project and add the Stop hook configuration
from `settings-snippet.json`. Your settings file should contain:

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

## How It Works

1. Claude Code fires the Stop hook when Claude is about to stop responding.
2. The hook script reads the hook input JSON from stdin and checks the `stop_hook_active` field.
3. **First stop attempt** (`stop_hook_active` is not set or false): The hook outputs a `"decision": "block"` response that prevents Claude from stopping and asks it to perform a session-end memory review.
4. **Second stop attempt** (`stop_hook_active` is true): The hook exits with code 0, allowing Claude to stop normally.

This prevents the infinite loop where blocking the stop would trigger another stop, which would
trigger the hook again, forever.

## Infinite Loop Prevention

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

## Troubleshooting

**Hook not firing:** Check that the script is executable (`ls -la .claude/hooks/`) and that
the path in `settings.json` matches the actual script location.

**`jq: command not found`:** Install jq (see Prerequisites above).

**Claude loops and never stops:** The `stop_hook_active` check should prevent this. If it
happens, check that your `jq` version supports the `// "false"` default syntax (jq 1.5+).

## Notes

- The hooks only trigger session-end review for Claude Code users. The `memory-guidance` prompt
  resource works for all MCP clients regardless of hook support.
- The Stop hook has a 10-second timeout. Memory review calls to the MCP server should complete
  well within this window.
- Hooks are configured per-project in `.claude/settings.json`. Each project that uses
  agent-brain can have these hooks enabled independently.
