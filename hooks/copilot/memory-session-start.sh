#!/bin/bash
# Copilot CLI sessionStart Hook: Pre-warm agent-brain session
# Calls the REST API to initialize a session so subsequent MCP tool calls are faster.
# NOTE: Copilot CLI ignores sessionStart output — the agent must still call
# memory_session_start via MCP tools. This hook just warms the server connection.

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

USER_ID=$(whoami)
PROJECT_ID=$(basename "$CWD")
SESSION_KEY="${COPILOT_SESSION_ID:-$(date +%Y%m%d%H%M%S)}"

# Check server health — fail gracefully if server is down
if ! curl -sf http://localhost:19898/health >/dev/null 2>&1; then
  exit 0
fi

# Pre-warm: call session start API so the server is ready
RESPONSE=$(curl -s -X POST http://localhost:19898/api/tools/memory_session_start \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"${PROJECT_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}")

if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Stash agent-brain session_id for the session-end hook
AB_SESSION_ID=$(echo "$RESPONSE" | jq -r '.meta.session_id // ""')
if [ -n "$AB_SESSION_ID" ]; then
  echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${SESSION_KEY}"
fi

exit 0
