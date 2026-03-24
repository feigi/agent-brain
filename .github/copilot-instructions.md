## Agent Memory

This project uses [Agentic Brain](https://github.com/feigi/agent-brain) for shared team knowledge.

### Available Tools

- **memory_search** -- Search for relevant memories. Call with a query describing what you need.
- **memory_create** -- Save a new memory from important context the user shares.
- **memory_get** -- Read a specific memory by ID.
- **memory_update** -- Modify an existing memory.
- **memory_comment** -- Append a comment to an existing memory (turns it into a thread).
- **memory_verify** -- Confirm a memory is still accurate (updates verified_at).
- **memory_archive** -- Archive a memory that is no longer relevant.
- **memory_list_stale** -- List memories that need review (old or unverified).

### When to Call `memory_search`

**Call `memory_search` before actions that affect shared systems.** This includes:
1. **The user asks about notes, context, or team knowledge** -- e.g. "any notes?", "what should I know?"
2. **Before actions that affect shared infrastructure** -- deploys, database migrations, credential rotation, etc.
3. **Before running shared/integration tests** (e.g. E2E, load tests) -- but NOT local unit tests or builds

**Do NOT search for purely local actions** like editing files, installing dependencies, running local builds, linting, or formatting.

### When the User Shares Important Context

If the user mentions decisions, temporary changes, or gotchas that the team should know about, suggest saving a memory with `memory_create`. Always confirm before saving.

### Presenting Memories

Always **number** memories and include **author**, **date**, and **title**. The user may refer to memories by number (e.g. "archive memory 2", "comment on 1").
