import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMemoryGuidance(server: McpServer): void {
  server.registerPrompt(
    "memory-guidance",
    {
      description:
        "Guidelines for autonomous memory capture -- what to remember and when",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: MEMORY_GUIDANCE_TEXT,
          },
        },
      ],
    }),
  );
}

export const MEMORY_GUIDANCE_TEXT = `
## Memory Capture Guidelines

You have access to a long-term memory system. Save insights that will be valuable in future sessions.

### What to Capture

All memory types are equal priority -- use your judgment based on context:

- **Decisions**: Architecture choices, technology selections, trade-off resolutions
- **Conventions**: Naming patterns, file organization rules, coding standards agreed upon
- **Gotchas**: Non-obvious bugs, workarounds, platform quirks discovered during work
- **Architecture**: System boundaries, data flow patterns, integration points
- **Patterns**: Reusable solutions that worked, anti-patterns to avoid
- **Preferences**: User preferences for tools, approaches, communication style

### When to Save (Natural Breakpoints)

Save at natural breakpoints throughout the session -- don't wait until the end:

- After completing a task or subtask
- After a commit that involved a non-obvious decision
- When discovering something surprising about the codebase
- After resolving a tricky bug (save the root cause + fix)
- When the user shares team context, decisions, or background information

### When NOT to Save

- Trivial facts easily found in code (import paths, obvious function signatures)
- Temporary debugging observations that don't generalize
- Information already captured in an existing memory (use memory_search first)
- Task-specific details that won't be useful in future sessions

### Session-End Review

When the session is ending, review your work and extract any remaining learnings not yet captured.
Use source: 'session-review' for end-of-session saves to distinguish them from mid-session captures.

Focus your review on:
- Decisions made that aren't obvious from the code
- Patterns discovered during implementation
- Gotchas or surprises encountered and resolved
- Context shared by the user that future sessions would benefit from

### Budget Awareness

You have a limited write budget per session (default: 10 autonomous saves).
Prioritize the most impactful insights -- not every observation needs to be saved.

If the budget is exceeded, the server will softly reject autonomous saves. You can still
force-save critical information by using source: 'manual' -- this bypasses the budget limit
and signals intentional user-directed saves.
`.trim();
