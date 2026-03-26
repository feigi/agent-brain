---
status: diagnosed
trigger: "SessionStart agent hook for agent-brain memory loading never fires"
created: 2026-03-24T00:00:00Z
updated: 2026-03-24T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED - SessionStart only supports type "command" hooks; "agent" type is silently ignored
test: Checked official Claude Code documentation
expecting: Documentation confirms limitation
next_action: Return diagnosis

## Symptoms

expected: When a Claude Code session starts in agent-brain, the SessionStart agent hook fires, shows "Loading memories..." status, calls memory_session_start MCP tool, injects memories into context.
actual: The hook never runs — no "Loading memories..." status message appears, no memories loaded.
errors: None visible — silently doesn't run.
reproduction: Start any new Claude Code session in /Users/chris/dev/agent-brain. The hook at settings.json line 36-41 never triggers.
started: Has never worked since being added.

## Eliminated

## Evidence

- timestamp: 2026-03-24T00:01:00Z
  checked: Claude Code official documentation for hook types
  found: Four hook types exist - "command", "http", "prompt", "agent". All are valid hook types in general.
  implication: The hook type itself is not invalid syntax.

- timestamp: 2026-03-24T00:02:00Z
  checked: Claude Code documentation for SessionStart event specifically
  found: "SessionStart runs when Claude Code starts a new session... Only type: 'command' hooks are supported." (from code.claude.com/docs/en/hooks)
  implication: ROOT CAUSE - The SessionStart event ONLY supports "command" type hooks. The "agent" type hook is silently ignored because it's not a supported type for this specific event.

- timestamp: 2026-03-24T00:03:00Z
  checked: settings.json hook configuration structure
  found: The agent hook at lines 33-41 uses type "agent" with prompt and statusMessage fields. This is valid schema for events that support agent hooks, but SessionStart is not one of those events.
  implication: The hook definition is syntactically valid but semantically incompatible with the SessionStart event.

## Resolution

root_cause: The SessionStart hook event in Claude Code only supports type "command" hooks. The memory-loading hook is configured as type "agent", which is silently ignored by SessionStart. Agent hooks are valid for other events (like PreToolUse, PostToolUse, Stop) but NOT for SessionStart.
fix: Convert the agent hook to a command hook. The command hook should output JSON with an "additionalContext" field containing the memory loading instructions/results. Options include: (a) write a command script that calls the MCP tool and returns context as JSON stdout, or (b) use a command hook that outputs additionalContext with a prompt telling Claude to call the memory_session_start tool as its first action.
verification:
files_changed: []
