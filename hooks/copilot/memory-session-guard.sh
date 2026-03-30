#!/bin/bash
# Copilot CLI preToolUse Hook: Block all tools until memory_session_start is called.
# Outputs permissionDecision: deny if the session guard flag exists and the tool
# being called is not memory_session_start. This is the only Copilot CLI hook
# whose output is processed by the agent.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.toolName // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Derive a stable per-directory session key
CWD_HASH=$(echo "$CWD" | sha256sum 2>/dev/null | cut -c1-8 || echo "default")
GUARD_FLAG="/tmp/copilot-guard-${CWD_HASH}"

# If no guard flag exists, memory_session_start was already called — allow everything
if [ ! -f "$GUARD_FLAG" ]; then
  exit 0
fi

# memory_session_start itself must always be allowed (it's what clears the flag)
if echo "$TOOL_NAME" | grep -qi "memory_session_start"; then
  exit 0
fi

# All other tools are blocked until memory_session_start is called
echo '{"permissionDecision":"deny","permissionDecisionReason":"You must call memory_session_start before using any other tools. Call it now to load team memories, then retry."}'
exit 0
