#!/bin/bash
# Claude Code Stop Hook: Session-End Memory Review
# Only fires if real work (file edits, task management) was done this session.

INPUT=$(cat)
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // "false"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
STATE_FILE="/tmp/claude-session-reviewed-${SESSION_ID}"

# If Claude is responding to the review prompt, mark session as reviewed and allow stop
if [ "$STOP_ACTIVE" = "true" ]; then
  touch "$STATE_FILE"
  exit 0
fi

# If we've already done the review this session, don't block again
if [ -f "$STATE_FILE" ]; then
  exit 0
fi

# Check if any meaningful work was done (file edits, task management)
# Skip the review for sessions that were just questions or exploration
HAS_WORK=false
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  if grep -qE '"name":\s*"(Edit|Write|NotebookEdit|TaskCreate|TaskUpdate|TaskStop)"' "$TRANSCRIPT_PATH" 2>/dev/null; then
    HAS_WORK=true
  fi
else
  # No transcript available — always review to be safe
  HAS_WORK=true
fi

if [ "$HAS_WORK" = "false" ]; then
  touch "$STATE_FILE"
  exit 0
fi

# Real work detected — block and request review
cat <<'REVIEW'
{
  "decision": "block",
  "reason": "Before ending, please perform a session-end memory review: reflect on this session's work and save any key learnings, decisions, conventions, or patterns worth remembering using memory_create with source 'session-review'. Focus on insights that will help in future sessions. If this session had no meaningful work (e.g. a brief question, no code changes, no decisions made), just say 'Nothing to save this session' and stop — do not create a placeholder memory. Then you may stop."
}
REVIEW
exit 0
