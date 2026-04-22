#!/bin/bash
# Claude Code PreToolUse hook: auto-fill user_id and workspace_id for
# mcp__agent-brain__* tool calls. Prevents the agent from guessing wrong
# values (e.g. wrong-case user_id). Configure with matcher "mcp__agent-brain__.*".

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
USER_ID=$(whoami | tr '[:upper:]' '[:lower:]')
WORKSPACE_ID=$(basename "$CWD")

TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
MODIFIED=$(echo "$TOOL_INPUT" | jq -c \
  --arg u "$USER_ID" \
  --arg w "$WORKSPACE_ID" \
  'if (.user_id // "") == "" then .user_id = $u else . end
   | if (.workspace_id // "") == "" then .workspace_id = $w else . end')

if [ "$MODIFIED" = "$TOOL_INPUT" ]; then
  exit 0
fi

jq -cn --argjson input "$MODIFIED" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: $input}}'

exit 0
