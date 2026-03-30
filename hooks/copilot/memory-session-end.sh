#!/bin/bash
# Copilot CLI sessionEnd Hook: Finalize agent-brain session
# Cleans up temp files created by the session-start hook.
# NOTE: Copilot CLI ignores sessionEnd output — this is for cleanup only.

INPUT=$(cat)
SESSION_KEY="${COPILOT_SESSION_ID:-$(date +%Y%m%d%H%M%S)}"
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Clean up guard and init-done markers so the next session requires memory_session_start again
if [ -n "$CWD" ]; then
  CWD_HASH=$(echo "$CWD" | sha256sum 2>/dev/null | cut -c1-8 || echo "default")
  rm -f "/tmp/copilot-guard-${CWD_HASH}" 2>/dev/null
  rm -f "/tmp/copilot-init-done-${CWD_HASH}" 2>/dev/null
fi

# Clean up stashed session ID
rm -f "/tmp/agent-brain-sid-${SESSION_KEY}" 2>/dev/null

# Clean up nudge counter
rm -f "/tmp/copilot-memory-nudge-${SESSION_KEY}" 2>/dev/null

exit 0
