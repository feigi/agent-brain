#!/bin/bash
# Copilot CLI sessionStart Hook: inject agent-brain memories as additionalContext.
# Requires Copilot CLI v1.0.22+: needs additionalContext honoring (v1.0.11+) AND
# once-per-session firing (v1.0.22+).
# Fails silently (exit 0 empty) when the server is unreachable or returns an error.

INPUT=$(cat)
AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"

CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_KEY="${COPILOT_SESSION_ID:-$(echo "$INPUT" | jq -r '.session_id // ""')}"
[ -z "$SESSION_KEY" ] && SESSION_KEY=$(date +%Y%m%d%H%M%S)

USER_ID=$(whoami)
WORKSPACE_ID=$(basename "$CWD")

if ! curl -sf "${AGENT_BRAIN_URL}/health" >/dev/null 2>&1; then
  exit 0
fi

# -f makes curl exit non-zero on HTTP 4xx/5xx so error bodies don't leak into
# additionalContext as fake "memories".
RESPONSE=$(curl -sf -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"${WORKSPACE_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}") || exit 0

if [ -z "$RESPONSE" ]; then
  exit 0
fi

AB_SESSION_ID=$(echo "$RESPONSE" | jq -r '.meta.session_id // ""')
if [ -n "$AB_SESSION_ID" ]; then
  echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${SESSION_KEY}"
fi

# Emit both flat and wrapped envelopes. Copilot CLI docs currently disagree with
# the changelog on the shape — flat matches the confirmed-working preToolUse
# pattern; the hookSpecificOutput wrapper mirrors VS Code's shape. Extra keys are
# harmless, so emit both and let whichever Copilot parses win.
jq -cn --arg ctx "$RESPONSE" \
  '{additionalContext: $ctx,
    hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'

exit 0
