#!/bin/bash
# Claude Code SessionStart Hook: load agent-brain memories.
# Writes full memories to <cwd>/.agent-brain/session.md and emits a preview
# (title-only index + path) as additionalContext. Agent is instructed to Read
# the file before responding.
# On any failure, emits the existing fallback additionalContext.

INPUT=$(cat)
AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
CLIENT_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // .sessionId // ""')

USER_ID=$(whoami | tr '[:upper:]' '[:lower:]')
WORKSPACE_ID=$(basename "$CWD")

FALLBACK_MSG="Agent Brain session_start did not succeed — memories were not loaded this session. Call memory_search explicitly when team knowledge or prior context is relevant."

emit_fallback() {
  local reason="$1"
  echo "agent-brain SessionStart: ${reason}" >&2
  jq -cn --arg ctx "$FALLBACK_MSG" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
  exit 0
}

ensure_gitignore() {
  local cwd="$1"
  local gi="${cwd}/.gitignore"
  [ -d "$cwd" ] || return 0
  if [ ! -f "$gi" ] || ! grep -qxF ".agent-brain/" "$gi" 2>/dev/null; then
    printf "\n.agent-brain/\n" >> "$gi" 2>/dev/null || true
  fi
}

if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  emit_fallback "missing or invalid cwd"
fi

if ! curl -sf "${AGENT_BRAIN_URL}/health" >/dev/null 2>&1; then
  emit_fallback "server unreachable (${AGENT_BRAIN_URL}/health)"
fi

RESPONSE=$(curl -sf -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"${WORKSPACE_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}") \
  || emit_fallback "memory_session_start POST failed (HTTP 4xx/5xx or network error)"

if [ -z "$RESPONSE" ]; then
  emit_fallback "memory_session_start returned empty body"
fi

PREVIEW=$(echo "$RESPONSE" | jq -r '.preview // ""')
FULL=$(echo "$RESPONSE" | jq -r '.full // ""')
if [ -z "$PREVIEW" ] || [ -z "$FULL" ]; then
  emit_fallback "memory_session_start response missing preview/full fields"
fi

# Stash agent-brain session_id for the stop hook to read
if [ -n "$CLIENT_SESSION_ID" ]; then
  AB_SESSION_ID=$(echo "$RESPONSE" | jq -r '.meta.session_id // ""')
  if [ -n "$AB_SESSION_ID" ]; then
    echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${CLIENT_SESSION_ID}"
  fi
fi

DEST_DIR="${CWD}/.agent-brain"
DEST_FILE="${DEST_DIR}/session.md"
mkdir -p "$DEST_DIR" 2>/dev/null || emit_fallback "could not create ${DEST_DIR}"
printf "%s" "$FULL" > "$DEST_FILE" 2>/dev/null || emit_fallback "could not write ${DEST_FILE}"
ensure_gitignore "$CWD"

# Substitute {{PATH}} placeholder with the absolute file path.
# Escape sed-special chars (&, \, |) in the path so workspaces with
# unusual names (e.g. "foo&bar") don't silently corrupt the substitution.
ESCAPED_DEST=$(printf '%s' "$DEST_FILE" | sed 's/[&\\|]/\\&/g')
SUBSTITUTED_PREVIEW=$(printf "%s" "$PREVIEW" | sed "s|{{PATH}}|${ESCAPED_DEST}|g")
CTX_ESCAPED=$(printf "%s" "$SUBSTITUTED_PREVIEW" | jq -Rs '.')

cat <<EOF
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ${CTX_ESCAPED}}}
EOF
