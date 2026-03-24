#!/bin/bash
# Claude Code Stop Hook: Session-End Memory Review
# Only fires if real work (file edits, task management, or git commits) was done this session.

INPUT=$(cat)
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // "false"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
STATE_FILE="/tmp/claude-session-reviewed-${SESSION_ID}"
LOG="/tmp/claude-session-review-debug-${SESSION_ID}.log"

echo "[$(date)] stop_active=$STOP_ACTIVE session=$SESSION_ID transcript=$TRANSCRIPT_PATH" >> "$LOG"

# If Claude is responding to the review prompt, mark session as reviewed and allow stop
if [ "$STOP_ACTIVE" = "true" ]; then
  echo "[$(date)] stop_active=true, marking reviewed and exiting" >> "$LOG"
  touch "$STATE_FILE"
  exit 0
fi

# If we've already done the review this session, don't block again
if [ -f "$STATE_FILE" ]; then
  echo "[$(date)] already reviewed, exiting" >> "$LOG"
  exit 0
fi

# Derive session start time from transcript file creation (macOS/Linux compatible)
SESSION_START=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  if stat -f "%SB" -t "%s" "$TRANSCRIPT_PATH" >/dev/null 2>&1; then
    # macOS: use birth time (creation time)
    SESSION_START_TS=$(stat -f "%SB" -t "%s" "$TRANSCRIPT_PATH" 2>/dev/null)
  else
    # Linux: fall back to modification time of first write (close enough)
    SESSION_START_TS=$(stat -c "%Y" "$TRANSCRIPT_PATH" 2>/dev/null)
  fi
  SESSION_START="@${SESSION_START_TS}"
  echo "[$(date)] session_start=$SESSION_START (ts=$SESSION_START_TS)" >> "$LOG"
fi

# Check if any meaningful work was done (file edits, task management, or git commits)
HAS_WORK=false

# 1. Check transcript for file-modifying tool use
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  if grep -qE '"name":\s*"(Edit|Write|NotebookEdit|TaskCreate|TaskUpdate|TaskStop)"' "$TRANSCRIPT_PATH" 2>/dev/null; then
    HAS_WORK=true
    echo "[$(date)] has_work=true (transcript tools)" >> "$LOG"
  else
    echo "[$(date)] no work tools found in transcript" >> "$LOG"
  fi
else
  HAS_WORK=true
  echo "[$(date)] no transcript, defaulting has_work=true" >> "$LOG"
fi

# 2. Check for git commits made since session start (failsafe: skip if not a git repo)
if [ "$HAS_WORK" = "false" ] && [ -n "$SESSION_START" ]; then
  CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
  if [ -n "$CWD" ] && git -C "$CWD" rev-parse --git-dir >/dev/null 2>&1; then
    COMMITS=$(git -C "$CWD" log --oneline --after="$SESSION_START" 2>/dev/null)
    echo "[$(date)] git commits since session start ($(echo "$COMMITS" | wc -l | tr -d ' ')) in $CWD" >> "$LOG"
    if echo "$COMMITS" | grep -q .; then
      HAS_WORK=true
      echo "[$(date)] has_work=true (git commits)" >> "$LOG"
    fi
  else
    echo "[$(date)] not a git repo or no cwd: $CWD" >> "$LOG"
  fi
fi

echo "[$(date)] final has_work=$HAS_WORK" >> "$LOG"

if [ "$HAS_WORK" = "false" ]; then
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
