import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMemoryGuidance(server: McpServer): void {
  server.registerPrompt(
    "memory-guidance",
    {
      description:
        "Guidelines for autonomous memory capture — what to remember and when",
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

Long-term memory system available. Save insights valuable in future sessions.

### Memory Scopes

- **workspace** (default): Visible to team in this workspace. Requires workspace_id.
- **user**: Private to you, visible across your workspaces.
- **project**: Visible to all users across ALL workspaces. For universal project knowledge (coding standards, architecture principles). Autonomous saves (source \`agent-auto\` or \`session-review\`) must first ask user to confirm cross-workspace scope, then retry with \`user_confirmed_project_scope: true\`. Manual saves (source \`manual\`) bypass this guard.

### What to Capture

All types equal priority — use judgment based on context:

- **Decisions**: Architecture choices, technology selections, trade-off resolutions
- **Conventions**: Naming patterns, file organization rules, agreed coding standards
- **Gotchas**: Non-obvious bugs, workarounds, platform quirks
- **Architecture**: System boundaries, data flow, integration points
- **Patterns**: Reusable solutions that worked, anti-patterns to avoid
- **Preferences**: User preferences for tools, approaches, communication style

### When to Save (Natural Breakpoints)

Save at natural breakpoints throughout session — don't wait until end:

- After completing task or subtask
- After commit involving non-obvious decision
- On discovering something surprising in the codebase
- After resolving tricky bug (save root cause + fix)
- When user shares team context, decisions, background info

### Choosing \`source\`

Every autonomous or user-directed save picks exactly one source. Get this right — drives budget accounting + project-scope guards.

- \`manual\` — user explicitly told you to save ("remember this", "save that", "note that X"). Bypasses write budget + project-scope confirmation guard. Do NOT use \`manual\` for your own inferences, even if they feel important.
- \`agent-auto\` — you decided autonomously to save mid-conversation. Default for anything you initiate mid-session.
- \`session-review\` — ONLY when Stop-hook end-of-session review is triggering context. Never mid-session, never because user asked.

If unsure between \`manual\` and \`agent-auto\`: ask "did user tell me to save this, right now, in their most recent message?" Yes → \`manual\`. No → \`agent-auto\`.

### When NOT to Save

- Trivial facts easily found in code (import paths, obvious function signatures)
- Temporary debugging observations that don't generalize
- Info already captured in existing memory (use memory_search first)
- Task-specific details not useful in future sessions

### Session-End Review

When session ends, review work + extract remaining uncaptured learnings.
ONLY context where \`source: 'session-review'\` is correct. Any save triggered mid-conversation — even from wrap-up summary before Stop hook fires — must use \`agent-auto\` or \`manual\`.

Focus review on:
- Decisions not obvious from code
- Patterns discovered during implementation
- Gotchas or surprises encountered + resolved
- Context shared by user that future sessions need

### Budget Awareness

Limited write budget per session (default: 10 autonomous saves).
Prioritize most impactful insights — not every observation needs saving.

If budget exceeded, server softly rejects autonomous saves. Can still
force-save critical info via source: 'manual' — bypasses budget limit,
signals intentional user-directed saves.

### Memory Flags

At session start, may receive a \`flags\` array alongside memories. Issues
detected by consolidation engine needing attention.

**Auto-resolve when certainty is high:**
- \`verify\` flags: check claim against codebase (read files, grep code, check config).
  If confirmed accurate with high confidence, silently call \`memory_verify\` +
  \`memory_resolve_flag\` with \`accepted\`. No need to mention to user.
- \`duplicate\` / \`superseded\` flags: if redundancy obvious + unambiguous,
  silently archive + resolve.

**Recommend action for the rest:**
- Flags you can't auto-resolve (low certainty, judgment calls, contradictions, overrides):
  present to user with specific recommendation (archive, merge, update, dismiss)
  + reasoning. Don't list options — say what you'd do and why.
- Call \`memory_resolve_flag\` after user confirms or overrides.

**During normal work:**
- If you hit a flagged memory, mention its flag + recommend resolution in context.

**Resolutions:**
- \`accepted\`: acted on flag (archived, merged, updated)
- \`dismissed\`: false positive, no action needed
- \`deferred\`: skip for now, reappears next session
`.trim();
