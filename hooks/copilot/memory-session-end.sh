#!/bin/bash
# Copilot CLI sessionEnd Hook: Finalize agent-brain session
# NOTE: Copilot CLI fires sessionEnd on every turn, not just when the session
# actually ends. We must NOT delete init-done here — that would force the agent
# to re-call memory_session_start on every turn. The 12-hour expiry handles cleanup.

INPUT=$(cat)
SESSION_KEY="${COPILOT_SESSION_ID:-$(date +%Y%m%d%H%M%S)}"
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Only clean up the guard flag (not init-done — that must persist across turns)
if [ -n "$CWD" ]; then
  CWD_HASH=$(echo "$CWD" | sha256sum 2>/dev/null | cut -c1-8 || echo "default")
  rm -f "/tmp/copilot-guard-${CWD_HASH}" 2>/dev/null
fi

# Clean up stashed session ID
rm -f "/tmp/agent-brain-sid-${SESSION_KEY}" 2>/dev/null

# Clean up nudge counter
rm -f "/tmp/copilot-memory-nudge-${SESSION_KEY}" 2>/dev/null

exit 0
