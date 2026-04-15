#!/bin/bash
# Copilot CLI preToolUse hook (v1.0.24+): two responsibilities per tool call.
#   1. Auto-fill user_id/workspace_id on mcp__agent-brain__* calls via modifiedArgs.
#   2. Emit a periodic save-memories nudge every 20 tool calls via additionalContext.
# Session-start memory injection is handled by memory-session-start.sh.
# Fails silently (exit 0 empty) when nothing needs to be emitted.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_KEY="${COPILOT_SESSION_ID:-$(echo "$INPUT" | jq -r '.session_id // ""')}"
[ -z "$SESSION_KEY" ] && SESSION_KEY=$(date +%Y%m%d%H%M%S)

USER_ID=$(whoami)
WORKSPACE_ID=$(basename "$CWD")

OUTPUT_CONTEXT=""
OUTPUT_MODIFIED_ARGS=""

# ---- 1. Nudge counter (every 20 calls) ----
COUNTER_FILE="/tmp/copilot-memory-nudge-${SESSION_KEY}"
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE")
else
  COUNT=0
fi
# Guard against corrupted/non-numeric counter file (e.g. shared /tmp clobber).
[[ "$COUNT" =~ ^[0-9]+$ ]] || COUNT=0
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if (( COUNT % 20 == 0 )); then
  OUTPUT_CONTEXT="Memory check: if the user shared decisions, conventions, gotchas, or preferences worth remembering across sessions, suggest saving via memory_create. Skip if nothing notable."
fi

# ---- 2. Auto-fill IDs on agent-brain MCP calls ----
if [[ "$TOOL_NAME" == mcp__agent-brain__* ]]; then
  TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
  MODIFIED=$(echo "$TOOL_INPUT" | jq -c \
    --arg u "$USER_ID" \
    --arg w "$WORKSPACE_ID" \
    'if (.user_id // "") == "" then .user_id = $u else . end
     | if (.workspace_id // "") == "" then .workspace_id = $w else . end')
  if [ "$MODIFIED" != "$TOOL_INPUT" ]; then
    OUTPUT_MODIFIED_ARGS="$MODIFIED"
  fi
fi

# ---- Emit flat envelope (Copilot CLI v1.0.24+) ----
if [ -z "$OUTPUT_CONTEXT" ] && [ -z "$OUTPUT_MODIFIED_ARGS" ]; then
  exit 0
fi

jq -cn \
  --arg ctx "$OUTPUT_CONTEXT" \
  --argjson args "${OUTPUT_MODIFIED_ARGS:-null}" \
  '{}
   | (if $ctx != "" then .additionalContext = $ctx else . end)
   | (if $args != null then .modifiedArgs = $args else . end)'

exit 0
