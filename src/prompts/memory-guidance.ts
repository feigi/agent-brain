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

### Memory Scopes

- **workspace** (default): Visible to all team members in this workspace. Requires workspace_id.
- **user**: Private to you, visible across all your workspaces.
- **project**: Visible to all users across ALL workspaces. Use for universal project knowledge (coding standards, architecture principles). Autonomous saves (source \`agent-auto\` or \`session-review\`) must first ask the user to confirm cross-workspace scope, then retry with \`user_confirmed_project_scope: true\`. Manual saves (source \`manual\`) bypass this guard.

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

### Choosing \`source\`

Every autonomous or user-directed save must pick exactly one source. Get this right -- it drives budget accounting and project-scope guards.

- \`manual\` -- the user explicitly told you to save ("remember this", "save that", "note that X"). Bypasses write budget and the project-scope confirmation guard. Do NOT use \`manual\` for inferences you made yourself, even if they feel important.
- \`agent-auto\` -- you decided autonomously to save during a live conversation. This is the default for anything you initiate mid-session.
- \`session-review\` -- ONLY use when the Stop-hook end-of-session review is the triggering context. Never mid-session, never because the user asked you to save something.

If in doubt between \`manual\` and \`agent-auto\`: ask "did the user tell me to save this, right now, in their most recent message?" If yes -> \`manual\`. If no -> \`agent-auto\`.

### When NOT to Save

- Trivial facts easily found in code (import paths, obvious function signatures)
- Temporary debugging observations that don't generalize
- Information already captured in an existing memory (use memory_search first)
- Task-specific details that won't be useful in future sessions

### Session-End Review

When the session is ending, review your work and extract any remaining learnings not yet captured.
This is the ONLY context in which \`source: 'session-review'\` is correct. Any save triggered mid-conversation -- even one made as part of a wrap-up summary before the Stop hook fires -- must use \`agent-auto\` or \`manual\` instead.

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

### Memory Flags

At session start, you may receive a \`flags\` array alongside memories. These are issues
detected by the consolidation engine that need your attention.

**Auto-resolve when certainty is high:**
- For \`verify\` flags: check the claim against the codebase (read files, grep code, check config).
  If you can confirm accuracy with high confidence, silently call \`memory_verify\` and
  \`memory_resolve_flag\` with \`accepted\`. No need to mention these to the user.
- For \`duplicate\` / \`superseded\` flags: if the redundancy is obvious and unambiguous,
  silently archive and resolve.

**Recommend a course of action for the rest:**
- For flags you cannot auto-resolve (low certainty, judgment calls, contradictions, overrides),
  present them to the user with a specific recommendation (archive, merge, update, or dismiss)
  and your reasoning. Don't just list options — say what you'd do and why.
- Call \`memory_resolve_flag\` after the user confirms or overrides your recommendation.

**During normal work:**
- If you encounter a flagged memory, mention its flag and recommend resolution in context.

**Resolutions:**
- \`accepted\`: You acted on the flag (archived, merged, updated)
- \`dismissed\`: False positive, no action needed
- \`deferred\`: Skip for now, will appear in next session
`.trim();
