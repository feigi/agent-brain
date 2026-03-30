#!/bin/bash
# PreToolUse hook: Block writes to Claude Code's file-based auto-memory.
# Redirects the model to use agent-brain MCP tools instead.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // ""')

# Block writes targeting Claude Code auto-memory paths
# Actual path pattern: ~/.claude/projects/<project-slug>/memory/<file>.md
if [[ "$FILE_PATH" == */.claude/projects/*/memory/* ]]; then
  cat <<'EOF'
{"decision":"block","reason":"Do not write to Claude Code's file-based memory. Use agent-brain MCP tools instead: memory_create to save new memories, memory_update to modify existing ones."}
EOF
  exit 0
fi

# Allow all other writes
exit 0
