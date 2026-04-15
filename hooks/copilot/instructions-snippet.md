# Agent Memory

This project uses [agent-brain](https://github.com/feigi/agent-brain) (MCP server) for shared team knowledge.

## Session Start

If the `memory-pretool.sh` hook (Copilot CLI v1.0.24+) is installed, recent memories are injected as `additionalContext` on the first tool call of each session — no manual call needed.

If you are unsure whether the hook is active and no memories have appeared by the time of your first response, call `memory_session_start` yourself.

## Identity Parameters

- **`user_id`**: The OS username (output of `whoami`).
- **`workspace_id`**: The repository directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

When `memory-pretool.sh` is installed, these are auto-filled on every `mcp__agent-brain__*` call via `modifiedArgs`. Without the hook, you must provide them explicitly.

## When to Call `memory_search`

**Call `memory_search` before actions that affect shared systems.** This includes:

1. **The user asks about notes, context, or team knowledge** — e.g. "any notes?", "what should I know?"
2. **Before actions that affect shared infrastructure** — deploys, database migrations, credential rotation, etc.
3. **Before running shared/integration tests** (e.g. E2E, load tests) — but NOT local unit tests or builds

**Do NOT search for purely local actions** like editing files, installing dependencies, running local builds, linting, or formatting.

## Saving Memories

The goal is that nothing valuable is lost when a conversation ends. This includes team knowledge, but also user preferences, project context, and things you learn about how this codebase works.

Save a memory (or suggest one) when you encounter:

- A decision and its rationale (architecture, tooling, approach)
- A user preference about how they want you to work
- A gotcha, workaround, or non-obvious constraint
- Important project context that would help in a future session

You don't need to ask permission for every memory — use judgment. For things that are clearly worth keeping, save directly. For anything uncertain, suggest it briefly and let the user confirm.

## Verifying Memories

When you encounter a memory during your work and can confirm it's still accurate, call `memory_verify`. This boosts older memories that remain relevant, informs future cleanup and consolidation, and builds user confidence in the knowledge base.

## Session End

When the user signals they're done (e.g. "bye", "done", "that's all"), review the session for anything worth keeping before it ends. Consider saving:

- Decisions made and their rationale
- User preferences you learned
- Gotchas or workarounds discovered
- Important project context that would help in a future session

Skip the review if the session was trivial (e.g. a single question with no lasting context).

## Presenting Memories

Always **number** memories and include **author**, **date**, and **title**. The user may refer to memories by number (e.g. "archive memory 2", "comment on 1").

## Memory Flags

At session start, the response may include a `flags` array — issues detected by the consolidation engine. Handle them as follows:

**Auto-resolve when certainty is high:**

- For `verify` flags: check the claim against the codebase (read files, grep code, check config). If you can confirm accuracy with high confidence, silently call `memory_verify` and `memory_resolve_flag` with `accepted`. No need to mention these to the user.
- For `duplicate` / `superseded` flags: if the redundancy is obvious and unambiguous, silently archive and resolve.

**Recommend a course of action for the rest:**

- For flags you cannot auto-resolve (low certainty, judgment calls, contradictions, overrides), present them to the user with a specific recommendation (archive, merge, update, or dismiss) and your reasoning. Don't just list options — say what you'd do and why.
- Call `memory_resolve_flag` after the user confirms or overrides your recommendation.

**During normal work:**

- If you encounter a flagged memory, mention its flag and recommend resolution in context.
