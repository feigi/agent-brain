## Memory System

User use [agent-brain](https://github.com/feigi/agent-brain) (MCP server) as sole memory system all projects. Do NOT use Claude Code built-in file-based auto-memory (`~/.claude/projects/**/memory/`). All memory ops through agent-brain MCP tools (`memory_create`, `memory_search`, `memory_update`, etc.). Never write MEMORY.md or create files in memory/ directory.

### Session Start

Relevant memories load auto at session start via SessionStart hook. No manual `memory_session_start` call needed. Use `memory_search` for extra lookups during session.

### Identity Parameters

- **`user_id`**: OS username, output of `whoami`. User identity across all memory tools.
- **`workspace_id`**: Repo directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

### When to Call `memory_search`

**Call `memory_search` before actions affecting shared systems.** Includes:

1. **User asks about notes, context, team knowledge** — e.g. "any notes?", "what should I know?"
2. **Before actions affecting shared infra** — deploys, DB migrations, credential rotation, etc.
3. **Before shared/integration tests** (e.g. E2E, load tests) — NOT local unit tests or builds

**Do NOT search for purely local actions** like editing files, installing deps, local builds, linting, formatting.

### Saving Memories

Goal: nothing valuable lost when conversation ends. Includes team knowledge, user preferences, project context, things learned about codebase.

Save memory (or suggest) when encounter:

- Decision and rationale (architecture, tooling, approach)
- User preference about how they want you to work
- Gotcha, workaround, non-obvious constraint
- Important project context useful in future session

No need ask permission every memory — use judgment. Clearly worth keeping, save direct. Uncertain, suggest briefly, let user confirm.

### Choosing `source`

Every save pick exactly one of three values:

- `manual` — user explicitly told you save this, in most recent message ("remember X", "save that", "note that Y"). Bypasses write budget and project-scope guard. Do **not** use `manual` for things you decided save yourself, even if feel important.
- `agent-auto` — you decided autonomously save during live conversation. Default for anything you initiate mid-session.
- `session-review` — **only** when Stop-hook end-of-session review is triggering context. Never mid-session, never because user asked.

Quick test: "did user tell me save this, right now, in most recent message?" Yes → `manual`. No, and Stop hook running → `session-review`. Otherwise → `agent-auto`.

### Choosing Scope

Default **narrowest applicable scope** to reduce blast radius:

- `workspace` — shared within current workspace (default)
- `user` — private to user within current workspace
- `project` — cross-workspace, visible everywhere

If memory looks like global preference (e.g. uses "always", "never", "everywhere", or workflow rule not tied to specific repo), **ask user** whether apply globally (`project` scope) or current workspace only. Do not assume global.

### Verifying Memories

When encounter memory during work and confirm still accurate, call `memory_verify`. Boosts older memories still relevant, informs future cleanup/consolidation, builds user confidence in knowledge base.

### Session End

Stop hook prompts review session for important memories before termination. Follow guidance — no extra instructions here.

### Presenting Memories

Always **number** memories, include **author**, **date**, **title**. User may refer by number (e.g. "archive memory 2", "comment on 1").

### Memory Flags

At session start, response may include `flags` array — issues detected by consolidation engine. Handle as:

**Auto-resolve when certainty high:**

- `verify` flags: check claim against codebase (read files, grep code, check config). If confirm accuracy high confidence, silently call `memory_verify` and `memory_resolve_flag` with `accepted`. No need mention to user.
- `duplicate` / `superseded` flags: redundancy obvious and unambiguous, silently archive and resolve.

**Recommend course of action for rest:**

- Flags you cannot auto-resolve (low certainty, judgment calls, contradictions, overrides), present to user with specific recommendation (archive, merge, update, dismiss) and reasoning. Don't just list options — say what you'd do and why.
- Call `memory_resolve_flag` after user confirms or overrides.

**During normal work:**

- Encounter flagged memory, mention flag and recommend resolution in context.
