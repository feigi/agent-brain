#!/bin/bash
# Copilot CLI sessionStart Hook: inject agent-brain memories as additionalContext.
# Requires Copilot CLI v1.0.22+: needs additionalContext honoring (v1.0.11+) AND
# once-per-session firing (v1.0.22+).
# On failure, emits a fallback additionalContext so the agent knows to call
# memory_search explicitly instead of assuming no memories exist.

INPUT=$(cat)
AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"

CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_KEY="${COPILOT_SESSION_ID:-$(echo "$INPUT" | jq -r '.session_id // ""')}"
[ -z "$SESSION_KEY" ] && SESSION_KEY=$(date +%Y%m%d%H%M%S)

USER_ID=$(whoami | tr '[:upper:]' '[:lower:]')
WORKSPACE_ID=$(basename "$CWD")

FALLBACK_MSG="Agent Brain session_start did not succeed — memories were not loaded this session. Call memory_search explicitly when team knowledge or prior context is relevant."

# Emit both flat and wrapped envelopes. Copilot CLI docs currently disagree with
# the changelog on the shape — flat matches the confirmed-working preToolUse
# pattern; the hookSpecificOutput wrapper mirrors VS Code's shape. Extra keys are
# harmless, so emit both and let whichever Copilot parses win.
emit_envelope() {
  local ctx="$1"
  jq -cn --arg ctx "$ctx" \
    '{additionalContext: $ctx,
      hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
}

emit_fallback() {
  local reason="$1"
  echo "agent-brain sessionStart: ${reason}" >&2
  emit_envelope "$FALLBACK_MSG"
  exit 0
}

if ! curl -sf "${AGENT_BRAIN_URL}/health" >/dev/null 2>&1; then
  emit_fallback "server unreachable (${AGENT_BRAIN_URL}/health)"
fi

# -f makes curl exit non-zero on HTTP 4xx/5xx so error bodies don't leak into
# additionalContext as fake "memories".
RESPONSE=$(curl -sf -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"${WORKSPACE_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}") \
  || emit_fallback "memory_session_start POST failed (HTTP 4xx/5xx or network error)"

if [ -z "$RESPONSE" ]; then
  emit_fallback "memory_session_start returned empty body"
fi

AB_SESSION_ID=$(echo "$RESPONSE" | jq -r '.meta.session_id // ""')
if [ -n "$AB_SESSION_ID" ]; then
  echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${SESSION_KEY}"
fi

emit_envelope "$RESPONSE"

exit 0
