#!/bin/bash
# Copilot CLI preToolUse hook (v1.0.24+): three responsibilities in one pass.
#   1. Auto-fill user_id/workspace_id on mcp__agent-brain__* calls via modifiedArgs.
#   2. Inject session-start memories as additionalContext on the first call of a session.
#   3. Emit a periodic save-memories nudge every 20 tool calls via additionalContext.
# Fails silently (exit 0 empty) when the agent-brain server is unreachable.

INPUT=$(cat)
AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_KEY="${COPILOT_SESSION_ID:-$(echo "$INPUT" | jq -r '.session_id // ""')}"
[ -z "$SESSION_KEY" ] && SESSION_KEY=$(date +%Y%m%d%H%M%S)

USER_ID=$(whoami)
WORKSPACE_ID=$(basename "$CWD")

# Server down → let the tool run unchanged
if ! curl -sf "${AGENT_BRAIN_URL}/health" >/dev/null 2>&1; then
  exit 0
fi

OUTPUT_CONTEXT=""
OUTPUT_MODIFIED_ARGS=""

# ---- 1. Session-start memory inject (once per session) ----
SESSION_MARKER="/tmp/copilot-memory-session-${SESSION_KEY}"
if [ ! -f "$SESSION_MARKER" ]; then
  touch "$SESSION_MARKER"
  RESPONSE=$(curl -s -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
    -H 'Content-Type: application/json' \
    -d "{\"workspace_id\":\"${WORKSPACE_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}")
  if [ -n "$RESPONSE" ]; then
    OUTPUT_CONTEXT="$RESPONSE"
    AB_SESSION_ID=$(echo "$RESPONSE" | jq -r '.meta.session_id // ""')
    [ -n "$AB_SESSION_ID" ] && echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${SESSION_KEY}"
  fi
fi

# ---- 2. Nudge counter (every 20 calls) ----
COUNTER_FILE="/tmp/copilot-memory-nudge-${SESSION_KEY}"
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE")
else
  COUNT=0
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if (( COUNT % 20 == 0 )); then
  NUDGE="Memory check: if the user shared decisions, conventions, gotchas, or preferences worth remembering across sessions, suggest saving via memory_create. Skip if nothing notable."
  if [ -n "$OUTPUT_CONTEXT" ]; then
    OUTPUT_CONTEXT="${OUTPUT_CONTEXT}

${NUDGE}"
  else
    OUTPUT_CONTEXT="$NUDGE"
  fi
fi

# ---- 3. Auto-fill IDs on agent-brain MCP calls ----
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
