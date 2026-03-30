#!/bin/bash
# Copilot CLI sessionEnd Hook: Finalize agent-brain session

INPUT=$(cat)
SESSION_KEY="${COPILOT_SESSION_ID:-$(date +%Y%m%d%H%M%S)}"

# Clean up stashed session ID
rm -f "/tmp/agent-brain-sid-${SESSION_KEY}" 2>/dev/null

# Clean up nudge counter
rm -f "/tmp/copilot-memory-nudge-${SESSION_KEY}" 2>/dev/null

exit 0
