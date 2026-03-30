#!/bin/bash
# PostToolUse hook: Periodic reminder to consider saving memories mid-session.
# Fires every 20 tool calls to avoid noise. Uses a temp file as counter.

SESSION_KEY="${CLAUDE_SESSION_ID:-$(date +%Y%m%d)}"
COUNTER_FILE="/tmp/claude-memory-nudge-${SESSION_KEY}"

# Initialize or read counter
if [[ -f "$COUNTER_FILE" ]]; then
  COUNT=$(cat "$COUNTER_FILE")
else
  COUNT=0
fi

COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Only fire every 20 tool calls
if (( COUNT % 20 == 0 )); then
  echo '{"additionalContext":"Memory check: if the user shared decisions, conventions, gotchas, or preferences worth remembering across sessions, suggest saving via memory_create. Skip if nothing notable."}'
fi

exit 0
