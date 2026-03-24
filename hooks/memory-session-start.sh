#!/bin/bash
# Claude Code SessionStart Hook: Load agent-brain memories
# Starts the MCP server, calls memory_session_start, returns memories as additionalContext

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Only trigger for the agent-brain project
if [[ "$CWD" != */agent-brain* ]]; then
  exit 0
fi

USER_ID=$(whoami)
PROJECT_ID=$(basename "$CWD")
SERVER_DIR="$HOME/dev/agent-brain"

# JSON-RPC messages
INIT_REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"hook","version":"1.0"}}}'
INIT_NOTIF='{"jsonrpc":"2.0","method":"notifications/initialized"}'
CALL_REQ=$(cat <<JSONEOF
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_session_start","arguments":{"project_id":"${PROJECT_ID}","user_id":"${USER_ID}","limit":10}}}
JSONEOF
)

# Start MCP server, send requests, capture output
# The server reads from stdin line-by-line (JSON-RPC over stdio)
RESPONSE=$(cd "$SERVER_DIR" && {
  echo "$INIT_REQ"
  echo "$INIT_NOTIF"
  echo "$CALL_REQ"
} | npx --yes tsx src/server.ts 2>/dev/null | {
  # Read lines until we get the tools/call response (id:2)
  while IFS= read -r line; do
    if echo "$line" | jq -e 'select(.id == 2)' >/dev/null 2>&1; then
      echo "$line"
      break
    fi
  done
})

if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Extract the text content from the MCP response
MEMORIES=$(echo "$RESPONSE" | jq -r '.result.content[]?.text // empty' 2>/dev/null)

if [ -z "$MEMORIES" ]; then
  exit 0
fi

# Escape for JSON embedding
MEMORIES_ESCAPED=$(echo "$MEMORIES" | jq -Rs '.')

cat <<EOF
{"additionalContext": ${MEMORIES_ESCAPED}}
EOF
