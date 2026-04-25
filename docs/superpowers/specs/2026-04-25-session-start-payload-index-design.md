# Session-Start Payload: Index + Persisted-File Design

**Status:** design (pre-implementation)
**Date:** 2026-04-25
**Author:** chris

## Purpose

The current `memory_session_start` response (~40KB for 21 memories in this workspace) overflows Claude Code's ~2KB `additionalContext` preview budget. Memories beyond the first ~2KB are persisted to a tool-results file but are not auto-read, so they silently fall out of the model's context (memory `UhPeYgeER8c0Zaqqiny9Q`). As project-scope rules grow (currently 11 memories, ~7.5KB verbatim), no field-pruning or body-truncation strategy can keep verbatim load within the preview cap.

This spec replaces the verbatim-in-preview model with a two-layer design: a compact title-only index in the preview, plus a full-content file written by the hook that the agent is forced to `Read` as its first action. Per-task memory retrieval shifts toward `memory_search` calls driven by the index and updated CLAUDE.md guidance.

## Drivers

1. **Eliminate silent memory loss at session start.** Today, memories past the 2KB preview boundary are invisible to the agent unless it knows to look for them. Replace "best-effort fit" with "guaranteed delivery via forced file read".
2. **Scale with workspace size.** Workspaces accumulate project-scope rules and ranked workspace/user memories. The transport must not degrade as N grows.
3. **Make memory retrieval task-driven, not session-driven.** Reinforce `memory_search` as the primary lookup mechanism for in-task knowledge. Session start surfaces topics, not content.
4. **Keep cross-harness symmetry.** Claude Code and Copilot CLI share the same protocol — no harness-specific persistence path or shape branching.

## Scope

**In scope:**

- New wire shape for `memory_session_start` tool: `{ preview: string, full: string, meta }`.
- Pure renderers (`renderPreview`, `renderFull`) at the tool boundary; service layer unchanged.
- Hook-script changes (Claude Code + Copilot CLI): write `full` to a workspace-local file, substitute the path into `preview`, emit `preview` as `additionalContext`.
- CLAUDE.md / instructions snippet update to reframe `memory_search` as a liberal, task-driven primary lookup.
- Index-byte budget enforcement with project-scope priority.

**Out of scope:**

- Schema changes to memories (no `pinned` field, no body summaries).
- Consolidation-driven body shortening.
- New JIT mechanisms beyond the existing PreToolUse autofill (e.g., a UserPromptSubmit semantic-search hook). Considered, deferred.
- Backwards-compatibility shims. Deployment is local; breaking change is acceptable.

## Design

### Response shape

`memory_session_start` returns an envelope with three top-level fields:

```ts
interface SessionStartResponse {
  preview: string; // markdown, ≤ ~2KB; goes into additionalContext
  full: string; // markdown, no cap; written to disk by hook
  meta: EnvelopeMeta; // existing meta + new fields below
}
```

The legacy `data: MemorySummaryWithRelevance[]` field is removed from the wire response. This is a breaking change to the `memory_session_start` tool/REST API. No remote consumers exist; both shipped hooks update in the same PR. The service layer (`MemoryService.sessionStart`) keeps its existing return type for internal callers and tests.

### Preview format

Markdown, server-rendered. Layout:

```
IMPORTANT — full memories are NOT in this preview.
Index below shows N memories. Full bodies at:
{{PATH}}

You MUST Read this file before responding to the user's
first message. Do not proceed without it.

## Memory index

- <id> [<scope>] <type> — <title>
- <id> [<scope>] <type> — <title>
...

Search guidance: see your memory instructions
(CLAUDE.md / agent-brain snippet).
```

Each index row carries `id`, `scope`, `type`, `title` (decision **I3**). Estimated row size ≈ 80 bytes. Under the 1.5KB index cap (see Index byte budget below), ~18 rows fit; the remaining ~500 bytes of the 2KB preview hold the surrounding instructions.

`{{PATH}}` is a literal placeholder string in the server response. The hook substitutes the actual file path before emitting `additionalContext`. The placeholder lives in the server output (not the hook) so server-side tests can assert preview rendering without mocking the filesystem.

### Index byte budget

Server caps the index portion at 1.5KB, leaving ~500 bytes for the surrounding instructions. When index rows exceed the cap:

1. Always include all `scope=project` rows (global rules cannot be silently truncated — same invariant as today's `project_truncated` flag).
2. Drop lowest-relevance non-project rows until under budget.
3. Set `meta.index_truncated_count` to the number of dropped rows.

The persisted file is unaffected — it always contains every memory the server returned.

### Persisted file

Markdown, no length cap. One section per memory. Format per memory:

```
## <title>

- **id:** <id>
- **scope:** <scope> · **type:** <type> · **author:** <author>
- **created:** <date> · **updated:** <date> · **verified:** <date|none>
- **tags:** <comma-separated>

<content>
```

Sections grouped by scope (`## project rules`, `## workspace memories`, `## user memories`) for scan-friendliness. Order within group: relevance descending.

If `meta.flags` is non-empty, an additional `## flags` section enumerates each flag with the related memory id and reason — agent treats this as actionable.

Markdown chosen over JSON: agent reads file once into context; markdown is more token-dense (no key repetition, no escaping) and easier for the agent to scan and quote back. JSON is unnecessary because no script consumes the file.

### File path

`<workspace>/.agent-brain/session.md`

- Workspace-local, single file overwritten per session.
- Visible in the user's repo for debugging.
- Requires `.agent-brain/` to be in `.gitignore`. Hook (or installer) ensures the entry exists; if not, hook appends it.

Rationale: workspace-local beats `/tmp` for visibility and survives across machines if the user is debugging across reboots. Single-file overwrite avoids cleanup logic. The user explicitly chose this option.

### Hook script flow

Both `hooks/claude/memory-session-start.sh` and `hooks/copilot/memory-session-start.sh`:

1. POST `/api/tools/memory_session_start`.
2. On failure (server unreachable, HTTP error, empty body): emit existing fallback `additionalContext`. Do not write file.
3. On success:
   a. Ensure `<cwd>/.agent-brain/` directory exists; ensure `.agent-brain/` is in `<cwd>/.gitignore` (append if missing).
   b. Write `response.full` to `<cwd>/.agent-brain/session.md` (overwrite).
   c. Substitute `{{PATH}}` in `response.preview` with the absolute file path.
   d. Emit substituted preview as `additionalContext` (Claude wraps in `hookSpecificOutput`; Copilot emits both flat + wrapped envelopes — current pattern preserved).

### CLAUDE.md / instructions-snippet update

The existing "When to Call `memory_search`" section is restrictive ("only before shared-system actions; not for local actions"). The new design requires a more liberal policy. Replace with:

```
### Working with Loaded Memories

Session start delivers a TITLE-ONLY index of available memories
plus a forced read of `<workspace>/.agent-brain/session.md` for
full bodies. The agent should already have read this file by the
time it answers the first message.

### When to Call `memory_search`

Call `memory_search` whenever:
- The user's task touches a topic that overlaps an index title.
- You are reasoning about an unfamiliar area of the codebase or
  domain — even if no index entry obviously matches.
- You are about to take an action that affects shared systems
  (deploys, migrations, credentials, etc.).

Prefer false positives over misses. Searches are cheap; missing a
load-bearing memory is expensive.

For a specific entry by id, use `memory_get`.

Do NOT search for purely local actions (file edits, installs,
linting, formatting) unless the index suggests a relevant memory.
```

Per memory `n86khHlXf88S8Fq4i1NwT`, both `claude-md-snippet.md` and `instructions-snippet.md` update in the same PR. Run `diff` of the two snippets after edit; only intentional differences (framing, copilot-specific hook refs) should remain.

### Server changes

Rendering happens at the **tool boundary** (the wire layer), not inside the service. The service's internal `Envelope<MemorySummaryWithRelevance[]>` shape is preserved so existing service-level integration tests and other internal callers stay intact. The wire shape `{ preview, full, meta }` is produced by the tool wrapper.

**New module: `src/utils/session-start-render.ts`** — houses two pure renderers and the byte-budget logic. Pure functions, fully unit-testable without a backend.

```ts
export interface RenderPreviewResult {
  text: string; // markdown, ≤ 2KB target
  truncatedCount: number; // index rows dropped to fit budget
}

export function renderPreview(
  memories: MemorySummaryWithRelevance[],
  indexBudget?: number, // bytes; default 1500
): RenderPreviewResult;

export function renderFull(
  memories: MemorySummaryWithRelevance[],
  flags?: FlagResponse[],
): string;
```

**`src/services/memory-service.ts`** — unchanged. `sessionStart()` continues to return `Envelope<MemorySummaryWithRelevance[]>` populated as today (ranked + project-scoped, deduped, sorted), with flags + team_activity in meta.

**`src/tools/memory-session-start.ts`** — after calling `memoryService.sessionStart(...)`, calls `renderPreview` + `renderFull` and constructs the wire-shape response:

```ts
const envelope = await memoryService.sessionStart(...);
const previewResult = renderPreview(envelope.data);
const full = renderFull(envelope.data, envelope.meta.flags);
const meta = { ...envelope.meta, index_truncated_count: previewResult.truncatedCount };
return toolResponse({ preview: previewResult.text, full, meta });
```

**`src/routes/api-tools.ts`** — the REST hook endpoint for `memory_session_start` mirrors the same wrapping (the hook scripts hit the REST endpoint, not MCP). Both paths must produce identical wire shape.

**`src/types/envelope.ts`** — add `index_truncated_count?: number` to `EnvelopeCoreMeta`.

**No new top-level type for `SessionStartResponse`** — the wire shape lives only in the tool wrapper. If consumers need a TypeScript type, export it from `src/utils/session-start-render.ts`.

### Reliability and fallbacks

- **Agent skips the Read.** Mitigated by (1) explicit "MUST Read before responding" instruction in preview, and (2) CLAUDE.md guidance loaded earlier in context. If the agent still skips, the index alone gives it enough surface to call `memory_search`/`memory_get` reactively. Worst case degrades to today's behavior, not worse.
- **Server unreachable.** Hook emits existing fallback `additionalContext` ("session_start did not succeed — call memory_search explicitly"). No file written.
- **Disk write fails.** Hook detects, emits fallback. Logs reason to stderr.
- **`.gitignore` write race.** Hook checks-then-appends; not atomic, but `.gitignore` writes are idempotent (adding `.agent-brain/` twice is benign — git deduplicates).

## Testing

Unit:

- `renderPreview`: row count under/at/over budget; project-scope-priority drop order; truncated-count accounting; `{{PATH}}` placeholder present exactly once.
- `renderFull`: section grouping; flag section present iff flags non-empty; ordering within group.
- New `meta.index_truncated_count` populated correctly.

Integration (REST hook API):

- POST `/api/tools/memory_session_start` returns shape `{preview, full, meta}` with no legacy `data` field.
- Preview byte length within budget for synthetic 100-memory workspace.

Hook (manual / scripted):

- `echo '{"cwd":"/tmp/test-ws"}' | hooks/claude/memory-session-start.sh` writes `/tmp/test-ws/.agent-brain/session.md`, appends `.agent-brain/` to `/tmp/test-ws/.gitignore` if absent, and emits `additionalContext` containing the absolute path.
- Same flow for `hooks/copilot/memory-session-start.sh`.
- Output size sanity: `wc -c` of the emitted `additionalContext` line stays under ~2.2KB across realistic workspace sizes.

Snippet sync:

- `diff hooks/copilot/instructions-snippet.md hooks/claude/claude-md-snippet.md` after edit shows only known-intentional differences.

## Migration

Single PR:

1. Add `renderPreview`, `renderFull`, types, service-method change, tool-schema doc update.
2. Update both hook scripts.
3. Update both snippets.
4. Update tests.
5. Manually verify in a fresh Claude Code session: agent reads `<workspace>/.agent-brain/session.md` before first response.

No deprecation window. Local-only deployment.

## Open Questions

None at design time. All major decisions resolved in brainstorming session 2026-04-25.

## Non-Goals (deferred)

- **JIT semantic search via UserPromptSubmit hook.** Worth considering after the index design proves itself; would inject task-relevant memories per prompt, reducing reliance on the index. Defer until usage shows the index isn't enough.
- **Memory body summaries / consolidation-driven shortening.** No mechanism exists today; speculative ROI.
- **`pinned` schema field.** Today's `scope=project` already serves "must always load" semantics. Revisit if a finer distinction emerges.
