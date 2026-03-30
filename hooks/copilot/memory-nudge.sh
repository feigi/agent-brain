#!/bin/bash
# Copilot CLI postToolUse Hook: Counter-based tool usage audit log + guard flag cleanup.
# Mirrors the Claude Code nudge hook pattern — tracks tool invocations.
# Also removes the session guard flag when memory_session_start succeeds,
# allowing subsequent tool calls to proceed.
# NOTE: Copilot CLI ignores postToolUse output, so this is for side-effects only.

INPUT=$(cat)
SESSION_KEY="${COPILOT_SESSION_ID:-$(date +%Y%m%d%H%M%S)}"
COUNTER_FILE="/tmp/copilot-memory-nudge-${SESSION_KEY}"
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

TOOL_NAME=$(echo "$INPUT" | jq -r '.toolName // "unknown"')
RESULT_TYPE=$(echo "$INPUT" | jq -r '.toolResult.resultType // "unknown"')

# Initialize or read counter
if [[ -f "$COUNTER_FILE" ]]; then
  COUNT=$(cat "$COUNTER_FILE")
else
  COUNT=0
fi

COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Clear the session guard flag once memory_session_start is called.
# We don't check resultType because MCP tools don't use the same "success"/"failure"
# values as built-in tools — any non-denied completion should unblock the session.
if echo "$TOOL_NAME" | grep -qi "memory_session_start"; then
  if [ "$RESULT_TYPE" != "denied" ]; then
    CWD_HASH=$(echo "$CWD" | sha256sum 2>/dev/null | cut -c1-8 || echo "default")
    rm -f "/tmp/copilot-guard-${CWD_HASH}"
  fi
fi

exit 0
