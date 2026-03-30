#!/bin/bash
# Claude Code SessionStart Hook: Load agent-brain memories
# Calls the REST API on the persistent HTTP server

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
CLIENT_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // .sessionId // ""')

USER_ID=$(whoami)
PROJECT_ID=$(basename "$CWD")

# Check server health — fail gracefully if server is down
if ! curl -sf http://localhost:19898/health >/dev/null 2>&1; then
  exit 0
fi

RESPONSE=$(curl -s -X POST http://localhost:19898/api/tools/memory_session_start \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"${PROJECT_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}")

if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Stash agent-brain session_id for the stop hook to read
if [ -n "$CLIENT_SESSION_ID" ]; then
  AB_SESSION_ID=$(echo "$RESPONSE" | jq -r '.meta.session_id // ""')
  if [ -n "$AB_SESSION_ID" ]; then
    echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${CLIENT_SESSION_ID}"
  fi
fi

MEMORIES_ESCAPED=$(echo "$RESPONSE" | jq -Rs '.')

cat <<EOF
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ${MEMORIES_ESCAPED}}}
EOF
