#!/bin/bash
# Claude Code Stop Hook: Session-End Memory Review
# Triggers a memory review when Claude is about to stop responding.
# Install: copy to .claude/hooks/ and add to .claude/settings.json

INPUT=$(cat)
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // "false"')

# Prevent infinite loop -- if already in a stop hook cycle, let Claude stop
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

# Block the stop and ask Claude to review session learnings
cat <<'REVIEW'
{
  "decision": "block",
  "reason": "Before ending, please perform a session-end memory review: reflect on this session's work and save any key learnings, decisions, conventions, or patterns worth remembering using memory_create with source 'session-review'. Focus on insights that will help in future sessions. Then you may stop."
}
REVIEW
exit 0
