# Agent Memory

Project use [agent-brain](https://github.com/feigi/agent-brain) (MCP server) for shared team knowledge.

## Session Start

If `memory-session-start.sh` hook (Copilot CLI v1.0.11+) installed, recent memories inject as `additionalContext` at session start — no manual call needed.

Unsure if hook active and no memories appeared by first response, call `memory_session_start` yourself.

## Identity Parameters

- **`user_id`**: OS username (output of `whoami`).
- **`workspace_id`**: Repo directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

When `memory-pretool.sh` installed, auto-filled on every `mcp__agent-brain__*` call via `modifiedArgs`. Without hook, provide explicitly.

## When to Call `memory_search`

**Call `memory_search` before actions affecting shared systems.** Includes:

1. **User asks about notes, context, team knowledge** — e.g. "any notes?", "what should I know?"
2. **Before actions affecting shared infrastructure** — deploys, DB migrations, credential rotation, etc.
3. **Before shared/integration tests** (e.g. E2E, load tests) — NOT local unit tests or builds

**Do NOT search for purely local actions** like editing files, installing deps, local builds, linting, formatting.

## Saving Memories

Goal: nothing valuable lost when conversation ends. Includes team knowledge, user preferences, project context, things learned about codebase.

Save memory (or suggest) when encounter:

- Decision and rationale (architecture, tooling, approach)
- User preference about how they want you to work
- Gotcha, workaround, non-obvious constraint
- Important project context useful in future session

No need ask permission every memory — use judgment. Clearly worth keeping, save direct. Uncertain, suggest briefly, let user confirm.

## Verifying Memories

Encounter memory during work and confirm still accurate, call `memory_verify`. Boosts older memories still relevant, informs future cleanup/consolidation, builds user confidence in knowledge base.

## Session End

User signals done (e.g. "bye", "done", "that's all"), review session for anything worth keeping before end. Consider saving:

- Decisions made and rationale
- User preferences learned
- Gotchas or workarounds discovered
- Important project context useful in future session

Skip review if session trivial (e.g. single question, no lasting context).

## Presenting Memories

Always **number** memories, include **author**, **date**, **title**. User may refer by number (e.g. "archive memory 2", "comment on 1").

## Memory Flags

At session start, response may include `flags` array — issues detected by consolidation engine. Handle as:

**Auto-resolve when certainty high:**

- `verify` flags: check claim against codebase (read files, grep code, check config). If confirm accuracy high confidence, silently call `memory_verify` and `memory_resolve_flag` with `accepted`. No need mention to user.
- `duplicate` / `superseded` flags: redundancy obvious and unambiguous, silently archive and resolve.

**Recommend course of action for rest:**

- Flags you cannot auto-resolve (low certainty, judgment calls, contradictions, overrides), present to user with specific recommendation (archive, merge, update, dismiss) and reasoning. Don't just list options — say what you'd do and why.
- Call `memory_resolve_flag` after user confirms or overrides.

**During normal work:**

- Encounter flagged memory, mention flag and recommend resolution in context.
