## Memory System

User use [agent-brain](https://github.com/feigi/agent-brain) (MCP server) as sole memory system all projects. Do NOT use Claude Code built-in file-based auto-memory (`~/.claude/projects/**/memory/`). All memory ops through agent-brain MCP tools (`memory_create`, `memory_search`, `memory_update`, etc.). Never write MEMORY.md or create files in memory/ directory.

### Session Start

SessionStart hook delivers a TITLE-ONLY index of available memories plus a forced read of `<workspace>/.agent-brain/session.md` for full bodies. Read that file before answering the first user message. No manual `memory_session_start` call needed.

### Working with Loaded Memories

`<workspace>/.agent-brain/session.md` contains the full bodies of the memories indexed in the SessionStart preview. The preview lists `<id> [<scope>] <type> — <title>` per memory; full bodies are in the file. Read it once at session start; use it as your in-context reference until the next session.

### Identity Parameters

- **`user_id`**: OS username, output of `whoami`. User identity across all memory tools.
- **`workspace_id`**: Repo directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

### When to Call `memory_search`

Call `memory_search` whenever:

1. **The user's task touches a topic that overlaps an index title** — the title alone may not be enough; pull the full memory or related ones.
2. **You are reasoning about an unfamiliar area of the codebase or domain** — even if no index entry obviously matches.
3. **You are about to take an action affecting shared systems** — deploys, DB migrations, credential rotation, integration tests, etc.

Prefer false positives over misses. Searches are cheap; missing a load-bearing memory is expensive.

For a specific entry by id, use `memory_get`.

**Do NOT search for purely local actions** (file edits, dependency installs, local builds, linting, formatting) UNLESS the index suggests a relevant memory.

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
