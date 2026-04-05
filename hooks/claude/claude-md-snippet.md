## Memory System

This user uses [agent-brain](https://github.com/feigi/agent-brain) (MCP server) as their sole memory system across all projects. Do NOT use Claude Code's built-in file-based auto-memory system (`~/.claude/projects/**/memory/`). All memory operations go through agent-brain MCP tools (`memory_create`, `memory_search`, `memory_update`, etc.). Never write to MEMORY.md or create files in the memory/ directory.

### Session Start

Relevant memories are loaded automatically at session start via the SessionStart hook. No manual `memory_session_start` call is needed. Use `memory_search` for additional lookups during the session.

### Identity Parameters

- **`user_id`**: The OS username, i.e. the output of `whoami`. This is the user's identity across all memory tools.
- **`workspace_id`**: The repository directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

### When to Call `memory_search`

**Call `memory_search` before actions that affect shared systems.** This includes:

1. **The user asks about notes, context, or team knowledge** — e.g. "any notes?", "what should I know?"
2. **Before actions that affect shared infrastructure** — deploys, database migrations, credential rotation, etc.
3. **Before running shared/integration tests** (e.g. E2E, load tests) — but NOT local unit tests or builds

**Do NOT search for purely local actions** like editing files, installing dependencies, running local builds, linting, or formatting.

### Saving Memories

The goal is that nothing valuable is lost when a conversation ends. This includes team knowledge, but also user preferences, project context, and things you learn about how this codebase works.

Save a memory (or suggest one) when you encounter:

- A decision and its rationale (architecture, tooling, approach)
- A user preference about how they want you to work
- A gotcha, workaround, or non-obvious constraint
- Important project context that would help in a future session

You don't need to ask permission for every memory — use judgment. For things that are clearly worth keeping, save directly. For anything uncertain, suggest it briefly and let the user confirm.

### Choosing Scope

Default to the **narrowest applicable scope** to reduce blast radius:

- `workspace` — shared within the current workspace (default)
- `user` — private to the user within the current workspace
- `project` — cross-workspace, visible everywhere

If a memory appears to be a global preference (e.g. uses words like "always", "never", "everywhere", or describes a workflow rule not tied to a specific repo), **ask the user** whether it should apply globally (`project` scope) or just to the current workspace. Do not assume global scope.

### Verifying Memories

When you encounter a memory during your work and can confirm it's still accurate, call `memory_verify`. This boosts older memories that remain relevant, informs future cleanup and consolidation, and builds user confidence in the knowledge base.

### Session End

The Stop hook will prompt you to review the session for important memories before termination. Follow its guidance — no additional instructions needed here.

### Presenting Memories

Always **number** memories and include **author**, **date**, and **title**. The user may refer to memories by number (e.g. "archive memory 2", "comment on 1").

### Memory Flags

At session start, the response may include a `flags` array — issues detected by the consolidation engine. When present:

- Surface flags to the user before starting the main task
- For each flag, explain the issue and offer actions (archive, merge, update, or dismiss)
- Call `memory_resolve_flag` after the user decides (`accepted`, `dismissed`, or `deferred`)
- During normal work, if you encounter a flagged memory, mention its flag to the user
