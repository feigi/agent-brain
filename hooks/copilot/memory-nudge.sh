#!/bin/bash
# Copilot CLI postToolUse Hook: Counter-based tool usage audit log
# Mirrors the Claude Code nudge hook pattern — tracks tool invocations.
# NOTE: Copilot CLI ignores postToolUse output, so this is for audit/logging only.

INPUT=$(cat)
SESSION_KEY="${COPILOT_SESSION_ID:-$(date +%Y%m%d%H%M%S)}"
COUNTER_FILE="/tmp/copilot-memory-nudge-${SESSION_KEY}"

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

exit 0
