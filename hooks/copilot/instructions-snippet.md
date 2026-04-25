# Agent Memory

Project use [agent-brain](https://github.com/feigi/agent-brain) (MCP server) for shared team knowledge.

## Session Start

If `memory-session-start.sh` hook (Copilot CLI v1.0.24+) installed, SessionStart delivers a TITLE-ONLY index of available memories plus a forced read of `<workspace>/.agent-brain/session.md` for full bodies. Read that file before answering the first user message.

If unsure hook active AND no memories appeared by first response, call `memory_session_start` yourself.

## Working with Loaded Memories

`<workspace>/.agent-brain/session.md` contains the full bodies of the memories indexed in the SessionStart preview. The preview lists `<id> [<scope>] <type> — <title>` per memory; full bodies are in the file. Read it once at session start; use it as your in-context reference until the next session.

## Identity Parameters

- **`user_id`**: OS username (output of `whoami`).
- **`workspace_id`**: Repo directory name (e.g., `agent-brain` for `/Users/chris/dev/agent-brain`).

When `memory-pretool.sh` installed, auto-filled on every `mcp__agent-brain__*` call via `modifiedArgs`. Without hook, provide explicitly.

## When to Call `memory_search`

Call `memory_search` whenever:

1. **The user's task touches a topic that overlaps an index title** — the title alone may not be enough; pull the full memory or related ones.
2. **You are reasoning about an unfamiliar area of the codebase or domain** — even if no index entry obviously matches.
3. **You are about to take an action affecting shared systems** — deploys, DB migrations, credential rotation, integration tests, etc.

Prefer false positives over misses. Searches are cheap; missing a load-bearing memory is expensive.

For a specific entry by id, use `memory_get`.

**Do NOT search for purely local actions** (file edits, dependency installs, local builds, linting, formatting) UNLESS the index suggests a relevant memory.

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

When user signals done (e.g. "bye", "done", "that's all"), review session for anything worth keeping before end. Consider saving:

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
