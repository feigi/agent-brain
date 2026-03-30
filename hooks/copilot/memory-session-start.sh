#!/bin/bash
# Copilot CLI sessionStart Hook: Pre-warm agent-brain session and set guard flag.
# Calls the REST API to initialize a session so subsequent MCP tool calls are faster.
# Also creates a guard flag that blocks all tools until memory_session_start is called
# via the preToolUse hook (memory-session-guard.sh).
# NOTE: Copilot CLI ignores sessionStart output — the agent must still call
# memory_session_start via MCP tools. This hook just warms the server connection.

INPUT=$(cat)
AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

USER_ID=$(whoami)
PROJECT_ID=$(basename "$CWD")
SESSION_KEY="${COPILOT_SESSION_ID:-$(date +%Y%m%d%H%M%S)}"

# Create guard flag so preToolUse hook blocks all tools until memory_session_start is called
CWD_HASH=$(echo "$CWD" | sha256sum 2>/dev/null | cut -c1-8 || echo "default")
GUARD_FLAG="/tmp/copilot-guard-${CWD_HASH}"
INIT_DONE="/tmp/copilot-init-done-${CWD_HASH}"

# Only create the guard if memory_session_start hasn't been called yet this session.
# The init-done marker is set by the preToolUse hook when memory_session_start succeeds,
# and cleared by the sessionEnd hook (or expires after 12 hours as a safety net).
if [ ! -f "$INIT_DONE" ] || [ "$(find "$INIT_DONE" -mmin +720 2>/dev/null)" ]; then
  rm -f "$INIT_DONE" 2>/dev/null
  touch "$GUARD_FLAG"
fi

# Check server health — fail gracefully if server is down
if ! curl -sf "${AGENT_BRAIN_URL}/health" >/dev/null 2>&1; then
  exit 0
fi

# Pre-warm: call session start API so the server is ready
RESPONSE=$(curl -s -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
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
