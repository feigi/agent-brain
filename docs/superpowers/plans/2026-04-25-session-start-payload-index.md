# Session-Start Payload Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the verbatim `memory_session_start` response with a 2KB title-only index in `additionalContext` plus a full markdown body the hook writes to `<workspace>/.agent-brain/session.md` and the agent is forced to `Read` before responding.

**Architecture:** Pure renderers (`renderPreview`, `renderFull`) live in `src/utils/session-start-render.ts` and are called by both the MCP tool wrapper (`src/tools/memory-session-start.ts`) and the REST hook endpoint (`src/routes/api-tools.ts`). The service layer (`MemoryService.sessionStart`) is unchanged. Hook scripts (Claude + Copilot) write `response.full` to a workspace-local file, substitute the path into `response.preview`, and emit the substituted preview as `additionalContext`. CLAUDE.md / instructions snippet guidance for `memory_search` shifts from restrictive to liberal.

**Tech Stack:** TypeScript (Node ESM), vitest, drizzle, Zod, Express 5, MCP SDK, bash hook scripts.

**Spec:** `docs/superpowers/specs/2026-04-25-session-start-payload-index-design.md`

---

## File Structure

**New files:**

- `src/utils/session-start-render.ts` — `renderPreview` + `renderFull` pure functions, byte-budget logic.
- `tests/unit/session-start-render.test.ts` — unit tests for both renderers.

**Modified files:**

- `src/types/envelope.ts` — add `index_truncated_count?: number` to `EnvelopeCoreMeta`.
- `src/tools/memory-session-start.ts` — wrap service result with renderers, emit wire shape `{preview, full, meta}`.
- `src/routes/api-tools.ts` — same wrapping for the REST `memory_session_start` endpoint used by the hook scripts.
- `tests/integration/session-start.test.ts` — keep service-level assertions (still uses `result.data`); no changes here unless an assertion regresses.
- `tests/unit/mcp-schemas.test.ts` (if it asserts on tool output schema) — update output schema expectation.
- `hooks/claude/memory-session-start.sh` — write file, ensure `.gitignore`, substitute path.
- `hooks/copilot/memory-session-start.sh` — same.
- `hooks/claude/claude-md-snippet.md` — replace `When to Call memory_search` section + add `Working with Loaded Memories` section.
- `hooks/copilot/instructions-snippet.md` — same content, copilot framing.

**Untouched:**

- `src/services/memory-service.ts` — service-layer return shape preserved.
- All existing service-level integration tests pass without modification (they assert on `result.data`).

---

## Task 1: Add `index_truncated_count` to envelope meta

**Files:**

- Modify: `src/types/envelope.ts`

- [ ] **Step 1: Add field to `EnvelopeCoreMeta`**

In `src/types/envelope.ts`, add after the existing `project_scope_status` field inside the `EnvelopeCoreMeta` interface:

```ts
index_truncated_count?: number; // session_start only: count of index rows dropped to fit preview budget
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/envelope.ts
git commit -m "feat(session-start): add index_truncated_count to envelope meta"
```

---

## Task 2: Write failing unit test for `renderPreview` — basic shape

**Files:**

- Create: `tests/unit/session-start-render.test.ts`

- [ ] **Step 1: Create test file with first failing test**

Create `tests/unit/session-start-render.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  renderPreview,
  renderFull,
} from "../../src/utils/session-start-render.js";
import type { MemorySummaryWithRelevance } from "../../src/types/memory.js";

function mem(
  overrides: Partial<MemorySummaryWithRelevance> = {},
): MemorySummaryWithRelevance {
  return {
    id: "abc123",
    title: "Sample memory title",
    content: "Sample content body",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "alice",
    source: "manual",
    created_at: new Date("2026-04-25T00:00:00.000Z"),
    updated_at: new Date("2026-04-25T00:00:00.000Z"),
    verified_at: null,
    verified_by: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    relevance: 0.9,
    ...overrides,
  };
}

describe("renderPreview", () => {
  it("emits header, index rows, and search-guidance footer with {{PATH}} placeholder", () => {
    const memories = [
      mem({
        id: "id1",
        title: "First memory",
        scope: "project",
        type: "pattern",
      }),
      mem({
        id: "id2",
        title: "Second memory",
        scope: "workspace",
        type: "fact",
      }),
    ];

    const result = renderPreview(memories);

    expect(result.text).toContain("{{PATH}}");
    expect(result.text).toContain("MUST Read");
    expect(result.text).toContain("- id1 [project] pattern — First memory");
    expect(result.text).toContain("- id2 [workspace] fact — Second memory");
    expect(result.text).toContain("Search guidance");
    expect(result.truncatedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/session-start-render.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/session-start-render.js'`.

---

## Task 3: Implement `renderPreview` minimally to pass Task 2

**Files:**

- Create: `src/utils/session-start-render.ts`

- [ ] **Step 1: Create the module with minimal `renderPreview`**

Create `src/utils/session-start-render.ts`:

```ts
import type { MemorySummaryWithRelevance } from "../types/memory.js";
import type { FlagResponse } from "../types/flag.js";

export interface RenderPreviewResult {
  text: string;
  truncatedCount: number;
}

const DEFAULT_INDEX_BUDGET_BYTES = 1500;

const HEADER = `IMPORTANT — full memories are NOT in this preview.
Index below shows %COUNT% memories. Full bodies at:
{{PATH}}

You MUST Read this file before responding to the user's
first message. Do not proceed without it.

## Memory index
`;

const FOOTER = `
Search guidance: see your memory instructions
(CLAUDE.md / agent-brain snippet).
`;

function indexRow(m: MemorySummaryWithRelevance): string {
  return `- ${m.id} [${m.scope}] ${m.type} — ${m.title}`;
}

export function renderPreview(
  memories: MemorySummaryWithRelevance[],
  _indexBudget: number = DEFAULT_INDEX_BUDGET_BYTES,
): RenderPreviewResult {
  const rows = memories.map(indexRow);
  const indexBlock = rows.join("\n");
  const text =
    HEADER.replace("%COUNT%", String(memories.length)) + indexBlock + FOOTER;
  return { text, truncatedCount: 0 };
}

export function renderFull(
  _memories: MemorySummaryWithRelevance[],
  _flags?: FlagResponse[],
): string {
  return "";
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/unit/session-start-render.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/utils/session-start-render.ts tests/unit/session-start-render.test.ts
git commit -m "feat(session-start): renderPreview shell with header/index/footer"
```

---

## Task 4: Add failing test for project-scope priority on budget overflow

**Files:**

- Modify: `tests/unit/session-start-render.test.ts`

- [ ] **Step 1: Add test that exercises the budget overflow + project priority**

Append inside `describe("renderPreview", ...)`:

```ts
it("drops lowest-relevance non-project rows when index exceeds budget; never drops project rows", () => {
  const longTitle = "x".repeat(60);
  // 50 memories, mix of scopes; only project memories have ranked relevance "below" workspace
  const memories: MemorySummaryWithRelevance[] = [];
  for (let i = 0; i < 5; i++) {
    memories.push(
      mem({
        id: `proj${i}`,
        title: `${longTitle} project ${i}`,
        scope: "project",
        type: "pattern",
        relevance: 0.1, // intentionally low — must not be dropped
      }),
    );
  }
  for (let i = 0; i < 45; i++) {
    memories.push(
      mem({
        id: `ws${i}`,
        title: `${longTitle} workspace ${i}`,
        scope: "workspace",
        type: "fact",
        relevance: 0.9 - i * 0.01, // descending
      }),
    );
  }

  // Budget tight enough to force truncation
  const result = renderPreview(memories, 1500);

  // All 5 project rows present
  for (let i = 0; i < 5; i++) {
    expect(result.text).toContain(`proj${i} [project]`);
  }
  // truncatedCount > 0 and equals dropped non-project count
  expect(result.truncatedCount).toBeGreaterThan(0);
  // Highest-relevance workspace row is kept
  expect(result.text).toContain("ws0 [workspace]");
  // Lowest-relevance workspace row is dropped (ws44 has relevance ~0.46, lower than ws0 0.9)
  expect(result.text).not.toContain("ws44 [workspace]");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/session-start-render.test.ts`
Expected: FAIL — `truncatedCount` is 0; the assertion on `truncatedCount > 0` fails.

---

## Task 5: Implement budget enforcement in `renderPreview`

**Files:**

- Modify: `src/utils/session-start-render.ts`

- [ ] **Step 1: Replace `renderPreview` with budget-aware version**

Replace the existing `renderPreview` function in `src/utils/session-start-render.ts` with:

```ts
export function renderPreview(
  memories: MemorySummaryWithRelevance[],
  indexBudget: number = DEFAULT_INDEX_BUDGET_BYTES,
): RenderPreviewResult {
  // Always include all project-scope rows
  const projectRows = memories.filter((m) => m.scope === "project");
  // Non-project rows ranked by relevance descending (input may already be sorted; sort defensively)
  const nonProjectRows = memories
    .filter((m) => m.scope !== "project")
    .slice()
    .sort((a, b) => b.relevance - a.relevance);

  const projectLines = projectRows.map(indexRow);
  const projectBytes = byteLengthOfLines(projectLines);

  // Budget remaining for non-project rows
  let remaining = indexBudget - projectBytes;
  const keptNonProject: string[] = [];
  let truncatedCount = 0;
  for (const m of nonProjectRows) {
    const line = indexRow(m);
    const cost =
      keptNonProject.length === 0 && projectLines.length === 0
        ? line.length
        : line.length + 1; // +1 for joining newline
    if (cost <= remaining) {
      keptNonProject.push(line);
      remaining -= cost;
    } else {
      truncatedCount++;
    }
  }

  const indexBlock = [...projectLines, ...keptNonProject].join("\n");
  const totalCount =
    projectRows.length + keptNonProject.length + truncatedCount;
  const text =
    HEADER.replace("%COUNT%", String(totalCount)) + indexBlock + FOOTER;
  return { text, truncatedCount };
}

function byteLengthOfLines(lines: string[]): number {
  if (lines.length === 0) return 0;
  // Sum char lengths + (lines.length - 1) join newlines
  return lines.reduce((acc, l) => acc + l.length, 0) + (lines.length - 1);
}
```

(The `indexRow` and `HEADER`/`FOOTER` constants stay as defined in Task 3.)

- [ ] **Step 2: Run tests to verify both pass**

Run: `npx vitest run tests/unit/session-start-render.test.ts`
Expected: both `renderPreview` tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/utils/session-start-render.ts tests/unit/session-start-render.test.ts
git commit -m "feat(session-start): enforce index byte budget with project-scope priority"
```

---

## Task 6: Add failing test for `renderFull` — sections by scope + ordering

**Files:**

- Modify: `tests/unit/session-start-render.test.ts`

- [ ] **Step 1: Add `renderFull` describe block with first test**

Append to `tests/unit/session-start-render.test.ts`:

```ts
describe("renderFull", () => {
  it("groups memories into sections by scope with relevance-descending order within group", () => {
    const memories: MemorySummaryWithRelevance[] = [
      mem({
        id: "p1",
        title: "Proj A",
        scope: "project",
        relevance: 0.5,
        content: "Body P1",
      }),
      mem({
        id: "w2",
        title: "WS Low",
        scope: "workspace",
        relevance: 0.4,
        content: "Body W2",
      }),
      mem({
        id: "w1",
        title: "WS High",
        scope: "workspace",
        relevance: 0.9,
        content: "Body W1",
      }),
      mem({
        id: "u1",
        title: "User One",
        scope: "user",
        relevance: 0.7,
        content: "Body U1",
      }),
    ];

    const out = renderFull(memories);

    expect(out).toContain("## project rules");
    expect(out).toContain("## workspace memories");
    expect(out).toContain("## user memories");

    // Per-memory section uses title as a heading
    expect(out).toContain("## Proj A");
    expect(out).toContain("## WS High");
    expect(out).toContain("## WS Low");
    expect(out).toContain("## User One");

    // Frontmatter-style fields present
    expect(out).toContain("**id:** p1");
    expect(out).toContain("**scope:** project");
    expect(out).toContain("**type:** fact");

    // Body content present
    expect(out).toContain("Body P1");
    expect(out).toContain("Body W1");

    // Within workspace group, WS High appears before WS Low
    expect(out.indexOf("## WS High")).toBeLessThan(out.indexOf("## WS Low"));
  });

  it("emits a flags section when flags are non-empty, omits it otherwise", () => {
    const m = mem({ id: "m1", title: "T1", scope: "workspace" });
    const withoutFlags = renderFull([m]);
    expect(withoutFlags).not.toContain("## flags");

    const withFlags = renderFull(
      [m],
      [
        {
          flag_id: "f1",
          flag_type: "verify",
          memory: { id: "m1", title: "T1", content: "C1", scope: "workspace" },
          reason: "stale claim",
        },
      ],
    );
    expect(withFlags).toContain("## flags");
    expect(withFlags).toContain("f1");
    expect(withFlags).toContain("verify");
    expect(withFlags).toContain("stale claim");
  });
});
```

- [ ] **Step 2: Run test to verify both new tests fail**

Run: `npx vitest run tests/unit/session-start-render.test.ts`
Expected: FAIL — `renderFull` returns empty string, all `toContain` assertions fail.

---

## Task 7: Implement `renderFull`

**Files:**

- Modify: `src/utils/session-start-render.ts`

- [ ] **Step 1: Replace stub `renderFull` with real implementation**

Replace the placeholder `renderFull` function with:

```ts
const SECTION_HEADERS = {
  project: "## project rules",
  workspace: "## workspace memories",
  user: "## user memories",
} as const;

function formatDate(d: Date | null): string {
  if (!d) return "none";
  return d.toISOString().slice(0, 10);
}

function memorySection(m: MemorySummaryWithRelevance): string {
  const tags = m.tags && m.tags.length > 0 ? m.tags.join(", ") : "none";
  const verified = formatDate(m.verified_at);
  return `## ${m.title}

- **id:** ${m.id}
- **scope:** ${m.scope} · **type:** ${m.type} · **author:** ${m.author}
- **created:** ${formatDate(m.created_at)} · **updated:** ${formatDate(m.updated_at)} · **verified:** ${verified}
- **tags:** ${tags}

${m.content}
`;
}

function flagsSection(flags: FlagResponse[]): string {
  const lines = flags.map(
    (f) =>
      `- **${f.flag_id}** (${f.flag_type}) on \`${f.memory.id}\` "${f.memory.title}" — ${f.reason}`,
  );
  return `## flags

${lines.join("\n")}
`;
}

export function renderFull(
  memories: MemorySummaryWithRelevance[],
  flags?: FlagResponse[],
): string {
  const byScope = {
    project: [] as MemorySummaryWithRelevance[],
    workspace: [] as MemorySummaryWithRelevance[],
    user: [] as MemorySummaryWithRelevance[],
  };
  for (const m of memories) {
    byScope[m.scope].push(m);
  }
  for (const k of Object.keys(byScope) as Array<keyof typeof byScope>) {
    byScope[k].sort((a, b) => b.relevance - a.relevance);
  }

  const parts: string[] = [];
  for (const scope of ["project", "workspace", "user"] as const) {
    if (byScope[scope].length === 0) continue;
    parts.push(SECTION_HEADERS[scope]);
    for (const m of byScope[scope]) {
      parts.push(memorySection(m));
    }
  }

  if (flags && flags.length > 0) {
    parts.push(flagsSection(flags));
  }

  return parts.join("\n");
}
```

- [ ] **Step 2: Run tests to verify all pass**

Run: `npx vitest run tests/unit/session-start-render.test.ts`
Expected: all `renderPreview` and `renderFull` tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/utils/session-start-render.ts tests/unit/session-start-render.test.ts
git commit -m "feat(session-start): renderFull with scope-grouped sections + flags"
```

---

## Task 8: Wire renderers into MCP tool wrapper

**Files:**

- Modify: `src/tools/memory-session-start.ts`

- [ ] **Step 1: Read the existing tool wrapper for the current shape**

Run: `cat src/tools/memory-session-start.ts`
Expected: shows the current `registerMemorySessionStart` calling `memoryService.sessionStart` and returning `toolResponse(result)` directly.

- [ ] **Step 2: Replace the tool wrapper to apply renderers**

Replace the body of the `async (params) => { ... }` handler in `src/tools/memory-session-start.ts` with:

```ts
async (params) => {
  return withErrorHandling(async () => {
    const envelope = await memoryService.sessionStart(
      params.workspace_id,
      params.user_id,
      params.context,
      params.limit,
      params.project_limit,
    );
    const previewResult = renderPreview(envelope.data);
    const full = renderFull(envelope.data, envelope.meta.flags);
    return toolResponse({
      preview: previewResult.text,
      full,
      meta: {
        ...envelope.meta,
        index_truncated_count: previewResult.truncatedCount,
      },
    });
  });
},
```

Add the import at the top:

```ts
import { renderPreview, renderFull } from "../utils/session-start-render.js";
```

- [ ] **Step 3: Run typecheck + unit tests**

Run: `npm run typecheck && npx vitest run tests/unit/session-start-render.test.ts`
Expected: PASS, no type errors.

- [ ] **Step 4: Run full unit test suite to confirm no regression**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/memory-session-start.ts
git commit -m "feat(session-start): emit {preview, full, meta} from MCP tool wrapper"
```

---

## Task 9: Wire renderers into REST hook endpoint

**Files:**

- Modify: `src/routes/api-tools.ts` (lines around 40 — `memory_session_start` case)

- [ ] **Step 1: Read the REST handler to confirm shape**

Run: `sed -n '1,100p' src/routes/api-tools.ts`
Expected: shows a switch/case dispatcher; for `memory_session_start` it calls `memoryService.sessionStart(...)` and returns the envelope via `res.json(...)` or similar.

- [ ] **Step 2: Apply the same wrapping at the REST handler**

In `src/routes/api-tools.ts`, locate the `memory_session_start` branch (around line 40) and replace the response construction with the same shape produced by Task 8:

```ts
const envelope = await memoryService.sessionStart(
  body.workspace_id,
  body.user_id,
  body.context,
  body.limit,
  body.project_limit,
);
const previewResult = renderPreview(envelope.data);
const full = renderFull(envelope.data, envelope.meta.flags);
return res.json({
  preview: previewResult.text,
  full,
  meta: {
    ...envelope.meta,
    index_truncated_count: previewResult.truncatedCount,
  },
});
```

Add the import at the top:

```ts
import { renderPreview, renderFull } from "../utils/session-start-render.js";
```

(Adjust variable names — `body`/`req.body` — to match the actual file. Read the surrounding code before editing.)

- [ ] **Step 3: Run typecheck + unit + integration tests**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS.

Run: `npm test -- tests/integration/session-start.test.ts` (or full integration if Postgres is up)
Expected: PASS — service-level tests still pass because the service shape is unchanged.

- [ ] **Step 4: Live smoke check against the running dev server**

Restart the dev server if needed, then:

```bash
curl -sf -X POST "http://localhost:19898/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"agent-brain","user_id":"chris","limit":10}' \
  | jq 'keys, (.meta | keys), (.preview | length), (.full | length)'
```

Expected: top-level keys = `["full","meta","preview"]`; meta contains `index_truncated_count`; `preview.length` ≤ ~2200; `full.length` > preview length.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api-tools.ts
git commit -m "feat(session-start): emit {preview, full, meta} from REST hook endpoint"
```

---

## Task 10: Update Claude hook to write file + substitute path

**Files:**

- Modify: `hooks/claude/memory-session-start.sh`

- [ ] **Step 1: Read the current hook script for reference**

Run: `cat hooks/claude/memory-session-start.sh`
Expected: shows the script that POSTs the REST endpoint and wraps the response in `additionalContext`.

- [ ] **Step 2: Replace the hook with the new flow**

Overwrite `hooks/claude/memory-session-start.sh` with:

```bash
#!/bin/bash
# Claude Code SessionStart Hook: load agent-brain memories.
# Writes full memories to <cwd>/.agent-brain/session.md and emits a preview
# (title-only index + path) as additionalContext. Agent is instructed to Read
# the file before responding.
# On any failure, emits the existing fallback additionalContext.

INPUT=$(cat)
AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
CLIENT_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // .sessionId // ""')

USER_ID=$(whoami | tr '[:upper:]' '[:lower:]')
WORKSPACE_ID=$(basename "$CWD")

FALLBACK_MSG="Agent Brain session_start did not succeed — memories were not loaded this session. Call memory_search explicitly when team knowledge or prior context is relevant."

emit_fallback() {
  local reason="$1"
  echo "agent-brain SessionStart: ${reason}" >&2
  jq -cn --arg ctx "$FALLBACK_MSG" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
  exit 0
}

ensure_gitignore() {
  local cwd="$1"
  local gi="${cwd}/.gitignore"
  # Only touch .gitignore if cwd looks like a writable directory
  [ -d "$cwd" ] || return 0
  if [ ! -f "$gi" ] || ! grep -qxF ".agent-brain/" "$gi" 2>/dev/null; then
    printf "\n.agent-brain/\n" >> "$gi" 2>/dev/null || true
  fi
}

if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  emit_fallback "missing or invalid cwd"
fi

if ! curl -sf "${AGENT_BRAIN_URL}/health" >/dev/null 2>&1; then
  emit_fallback "server unreachable (${AGENT_BRAIN_URL}/health)"
fi

RESPONSE=$(curl -sf -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"${WORKSPACE_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}") \
  || emit_fallback "memory_session_start POST failed (HTTP 4xx/5xx or network error)"

if [ -z "$RESPONSE" ]; then
  emit_fallback "memory_session_start returned empty body"
fi

PREVIEW=$(echo "$RESPONSE" | jq -r '.preview // ""')
FULL=$(echo "$RESPONSE" | jq -r '.full // ""')
if [ -z "$PREVIEW" ] || [ -z "$FULL" ]; then
  emit_fallback "memory_session_start response missing preview/full fields"
fi

# Stash agent-brain session_id for the stop hook to read
if [ -n "$CLIENT_SESSION_ID" ]; then
  AB_SESSION_ID=$(echo "$RESPONSE" | jq -r '.meta.session_id // ""')
  if [ -n "$AB_SESSION_ID" ]; then
    echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${CLIENT_SESSION_ID}"
  fi
fi

DEST_DIR="${CWD}/.agent-brain"
DEST_FILE="${DEST_DIR}/session.md"
mkdir -p "$DEST_DIR" 2>/dev/null || emit_fallback "could not create ${DEST_DIR}"
printf "%s" "$FULL" > "$DEST_FILE" 2>/dev/null || emit_fallback "could not write ${DEST_FILE}"
ensure_gitignore "$CWD"

# Substitute {{PATH}} placeholder with the absolute file path
SUBSTITUTED_PREVIEW=$(printf "%s" "$PREVIEW" | sed "s|{{PATH}}|${DEST_FILE}|g")
CTX_ESCAPED=$(printf "%s" "$SUBSTITUTED_PREVIEW" | jq -Rs '.')

cat <<EOF
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ${CTX_ESCAPED}}}
EOF
```

- [ ] **Step 3: Make the script executable and run a smoke test against the dev server**

```bash
chmod +x hooks/claude/memory-session-start.sh
echo "{\"cwd\":\"$(pwd)\",\"session_id\":\"plan-task10-smoke\"}" | hooks/claude/memory-session-start.sh
```

Expected stdout: a JSON object with `hookSpecificOutput.additionalContext` containing the index, the substituted absolute path, and the "MUST Read" instruction.

Then verify the file was written:

```bash
ls -la .agent-brain/session.md
head -20 .agent-brain/session.md
grep -F ".agent-brain/" .gitignore
```

Expected: file exists with markdown content; `.gitignore` contains `.agent-brain/`.

- [ ] **Step 4: Commit**

```bash
git add hooks/claude/memory-session-start.sh .gitignore
git commit -m "feat(hooks/claude): write session.md, substitute path, emit preview"
```

(If `.gitignore` already had the entry, drop it from the `git add`.)

---

## Task 11: Update Copilot hook to mirror Task 10

**Files:**

- Modify: `hooks/copilot/memory-session-start.sh`

- [ ] **Step 1: Read the current Copilot hook**

Run: `cat hooks/copilot/memory-session-start.sh`
Expected: similar structure to the Claude hook but emits both flat and `hookSpecificOutput` envelopes.

- [ ] **Step 2: Replace the Copilot hook with the new flow**

Overwrite `hooks/copilot/memory-session-start.sh` with:

```bash
#!/bin/bash
# Copilot CLI SessionStart Hook: load agent-brain memories.
# Writes full memories to <cwd>/.agent-brain/session.md and emits a preview
# (title-only index + path) as additionalContext. Agent is instructed to Read
# the file before responding.
# Requires Copilot CLI v1.0.24+ (additionalContext + once-per-session firing).

INPUT=$(cat)
AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:19898}"

CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_KEY="${COPILOT_SESSION_ID:-$(echo "$INPUT" | jq -r '.session_id // ""')}"
[ -z "$SESSION_KEY" ] && SESSION_KEY=$(date +%Y%m%d%H%M%S)

USER_ID=$(whoami | tr '[:upper:]' '[:lower:]')
WORKSPACE_ID=$(basename "$CWD")

FALLBACK_MSG="Agent Brain session_start did not succeed — memories were not loaded this session. Call memory_search explicitly when team knowledge or prior context is relevant."

emit_envelope() {
  local ctx="$1"
  jq -cn --arg ctx "$ctx" \
    '{additionalContext: $ctx,
      hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
}

emit_fallback() {
  local reason="$1"
  echo "agent-brain sessionStart: ${reason}" >&2
  emit_envelope "$FALLBACK_MSG"
  exit 0
}

ensure_gitignore() {
  local cwd="$1"
  local gi="${cwd}/.gitignore"
  [ -d "$cwd" ] || return 0
  if [ ! -f "$gi" ] || ! grep -qxF ".agent-brain/" "$gi" 2>/dev/null; then
    printf "\n.agent-brain/\n" >> "$gi" 2>/dev/null || true
  fi
}

if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  emit_fallback "missing or invalid cwd"
fi

if ! curl -sf "${AGENT_BRAIN_URL}/health" >/dev/null 2>&1; then
  emit_fallback "server unreachable (${AGENT_BRAIN_URL}/health)"
fi

RESPONSE=$(curl -sf -X POST "${AGENT_BRAIN_URL}/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"${WORKSPACE_ID}\",\"user_id\":\"${USER_ID}\",\"limit\":10}") \
  || emit_fallback "memory_session_start POST failed (HTTP 4xx/5xx or network error)"

if [ -z "$RESPONSE" ]; then
  emit_fallback "memory_session_start returned empty body"
fi

PREVIEW=$(echo "$RESPONSE" | jq -r '.preview // ""')
FULL=$(echo "$RESPONSE" | jq -r '.full // ""')
if [ -z "$PREVIEW" ] || [ -z "$FULL" ]; then
  emit_fallback "memory_session_start response missing preview/full fields"
fi

AB_SESSION_ID=$(echo "$RESPONSE" | jq -r '.meta.session_id // ""')
if [ -n "$AB_SESSION_ID" ]; then
  echo "$AB_SESSION_ID" > "/tmp/agent-brain-sid-${SESSION_KEY}"
fi

DEST_DIR="${CWD}/.agent-brain"
DEST_FILE="${DEST_DIR}/session.md"
mkdir -p "$DEST_DIR" 2>/dev/null || emit_fallback "could not create ${DEST_DIR}"
printf "%s" "$FULL" > "$DEST_FILE" 2>/dev/null || emit_fallback "could not write ${DEST_FILE}"
ensure_gitignore "$CWD"

SUBSTITUTED_PREVIEW=$(printf "%s" "$PREVIEW" | sed "s|{{PATH}}|${DEST_FILE}|g")
emit_envelope "$SUBSTITUTED_PREVIEW"

exit 0
```

- [ ] **Step 3: Make executable + smoke test**

```bash
chmod +x hooks/copilot/memory-session-start.sh
echo "{\"cwd\":\"$(pwd)\",\"session_id\":\"plan-task11-smoke\"}" | hooks/copilot/memory-session-start.sh | jq 'keys'
```

Expected: `["additionalContext","hookSpecificOutput"]`. The `additionalContext` value contains the substituted path.

- [ ] **Step 4: Commit**

```bash
git add hooks/copilot/memory-session-start.sh
git commit -m "feat(hooks/copilot): write session.md, substitute path, emit preview"
```

---

## Task 12: Update CLAUDE.md snippet — replace search guidance + add Working with Loaded Memories

**Files:**

- Modify: `hooks/claude/claude-md-snippet.md`

- [ ] **Step 1: Replace the `Session Start` and `When to Call memory_search` sections**

In `hooks/claude/claude-md-snippet.md`, locate the existing `### Session Start` section (currently 2 lines) and the following `### When to Call memory_search` section. Replace both with:

```markdown
### Session Start

SessionStart hook delivers a TITLE-ONLY index of available memories
plus a forced read of `<workspace>/.agent-brain/session.md` for full
bodies. Read that file before answering the first user message.
No manual `memory_session_start` call needed.

### Working with Loaded Memories

`<workspace>/.agent-brain/session.md` contains the full bodies of the
memories indexed in the SessionStart preview. The preview lists
`<id> [<scope>] <type> — <title>` per memory; full bodies are in the
file. Read it once at session start; use it as your in-context
reference until the next session.

### When to Call `memory_search`

Call `memory_search` whenever:

1. **The user's task touches a topic that overlaps an index title** — the
   title alone may not be enough; pull the full memory or related ones.
2. **You are reasoning about an unfamiliar area of the codebase or domain**
   — even if no index entry obviously matches.
3. **You are about to take an action affecting shared systems** — deploys,
   DB migrations, credential rotation, integration tests, etc.

Prefer false positives over misses. Searches are cheap; missing a
load-bearing memory is expensive.

For a specific entry by id, use `memory_get`.

**Do NOT search for purely local actions** (file edits, dependency
installs, local builds, linting, formatting) UNLESS the index suggests
a relevant memory.
```

- [ ] **Step 2: Verify no other section header was disturbed**

Run: `grep -n "^##\|^###" hooks/claude/claude-md-snippet.md`
Expected: original heading order preserved except for the two replaced sections; no duplicates.

---

## Task 13: Mirror snippet update to Copilot instructions

**Files:**

- Modify: `hooks/copilot/instructions-snippet.md`

- [ ] **Step 1: Replace the equivalent sections in the Copilot snippet**

In `hooks/copilot/instructions-snippet.md`, locate the existing `## Session Start` section and the `## When to Call memory_search` section. Replace both with:

```markdown
## Session Start

If `memory-session-start.sh` hook (Copilot CLI v1.0.24+) installed,
SessionStart delivers a TITLE-ONLY index of available memories plus a
forced read of `<workspace>/.agent-brain/session.md` for full bodies.
Read that file before answering the first user message.

If unsure hook active AND no memories appeared by first response, call
`memory_session_start` yourself.

## Working with Loaded Memories

`<workspace>/.agent-brain/session.md` contains the full bodies of the
memories indexed in the SessionStart preview. The preview lists
`<id> [<scope>] <type> — <title>` per memory; full bodies are in the
file. Read it once at session start; use it as your in-context
reference until the next session.

## When to Call `memory_search`

Call `memory_search` whenever:

1. **User's task touches topic overlapping index title** — title alone
   may not be enough; pull full memory or related.
2. **Reasoning about unfamiliar area of codebase or domain** — even if
   no index entry obviously matches.
3. **About to take action affecting shared systems** — deploys, DB
   migrations, credential rotation, integration tests, etc.

Prefer false positives over misses. Searches cheap; missing a
load-bearing memory expensive.

For specific entry by id, use `memory_get`.

**Do NOT search for purely local actions** (file edits, dependency
installs, local builds, linting, formatting) UNLESS index suggests
relevant memory.
```

- [ ] **Step 2: Diff the two snippets to verify only intentional differences remain**

Run: `diff hooks/copilot/instructions-snippet.md hooks/claude/claude-md-snippet.md`
Expected: differences limited to:

- H1 heading (`# Agent Memory` vs `## Memory System`)
- Copilot-specific hook references and copilot-specific framing in `Session Start`
- Other intentional differences pre-existing in the files (e.g. `Choosing source` section structure differs)

If unexpected drift on the new sections appears, fix inline.

- [ ] **Step 3: Commit both snippet updates together**

```bash
git add hooks/claude/claude-md-snippet.md hooks/copilot/instructions-snippet.md
git commit -m "docs(hooks): liberal memory_search guidance + Working with Loaded Memories"
```

---

## Task 14: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Restart the dev server (so the new tool wrapper is live)**

Run whatever the project uses to restart the dev server — typically `npm run dev` in a fresh terminal, or restart the watcher. Verify health:

```bash
curl -sf "http://localhost:19898/health" && echo " — server up"
```

Expected: `{"status":"ok"}` (or similar) followed by ` — server up`.

- [ ] **Step 2: Hit the REST endpoint and inspect the new shape**

```bash
curl -sf -X POST "http://localhost:19898/api/tools/memory_session_start" \
  -H 'Content-Type: application/json' \
  -d '{"workspace_id":"agent-brain","user_id":"chris","limit":10}' \
  | jq '{
      keys: keys,
      preview_bytes: (.preview|length),
      full_bytes: (.full|length),
      meta_keys: (.meta|keys),
      truncated: (.meta.index_truncated_count // null),
      preview_has_path_placeholder: (.preview|test("\\{\\{PATH\\}\\}")),
      preview_has_must_read: (.preview|test("MUST Read"))
    }'
```

Expected:

- `keys`: includes `"preview"`, `"full"`, `"meta"` (no `"data"`).
- `preview_bytes` ≤ ~2200.
- `full_bytes` substantially larger than `preview_bytes`.
- `meta_keys` includes `index_truncated_count`.
- `preview_has_path_placeholder` = `true`.
- `preview_has_must_read` = `true`.

- [ ] **Step 3: Run the Claude hook end-to-end**

```bash
echo "{\"cwd\":\"$(pwd)\",\"session_id\":\"plan-task14-claude\"}" \
  | hooks/claude/memory-session-start.sh \
  | jq '.hookSpecificOutput.additionalContext' -r \
  | head -30
```

Expected: substituted preview text, `{{PATH}}` replaced with `<cwd>/.agent-brain/session.md` absolute path, "MUST Read" instruction visible, index lines below.

Then:

```bash
ls -la .agent-brain/session.md
wc -c .agent-brain/session.md
head -30 .agent-brain/session.md
grep -F ".agent-brain/" .gitignore
```

Expected: file exists with size > preview, content is grouped markdown sections, `.gitignore` contains the entry.

- [ ] **Step 4: Run the Copilot hook end-to-end**

```bash
echo "{\"cwd\":\"$(pwd)\",\"session_id\":\"plan-task14-copilot\"}" \
  | hooks/copilot/memory-session-start.sh \
  | jq '. | {keys: keys, ctx_head: (.additionalContext[0:300])}'
```

Expected: top-level keys `additionalContext` and `hookSpecificOutput`; `ctx_head` shows the substituted path and "MUST Read" instruction.

- [ ] **Step 5: Run the full test suite**

Run: `npm run typecheck && npm run lint && npm run test:unit`
Expected: all pass.

(Integration tests with Postgres can be skipped if DB not running locally; the unit suite + the live curl smoke covers the new code.)

- [ ] **Step 6: Inspect a real session in Claude Code (manual)**

Start a fresh Claude Code session in this repo. Confirm:

1. The agent's first action is a `Read` of `.agent-brain/session.md`.
2. The agent does not assume memory bodies are already in context.
3. If asked "what memories do you have?", the agent references content from `session.md`.

If the agent skips the Read, capture the failure and iterate on the wording in the preview header (the `HEADER` constant in `src/utils/session-start-render.ts`) and/or the CLAUDE.md snippet. Re-test.

- [ ] **Step 7: Final commit if any tweaks made during verification**

```bash
git status
# If anything changed during verification, commit it:
# git add <changed files>
# git commit -m "fix(session-start): adjust preview wording after manual verification"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Wire shape `{preview, full, meta}` → Tasks 8, 9.
  - Preview format with index + path + instruction → Tasks 2, 3, 5.
  - Index byte budget with project priority → Tasks 4, 5.
  - Persisted file format (sections by scope, flags) → Tasks 6, 7.
  - File path `<workspace>/.agent-brain/session.md` + `.gitignore` → Tasks 10, 11.
  - Hook script flow → Tasks 10, 11.
  - CLAUDE.md / instructions snippet update → Tasks 12, 13.
  - Reliability fallbacks (server unreachable, disk write fails) → Tasks 10, 11 fallback paths.
  - Manual verification (agent reads file) → Task 14 step 6.

- **No placeholders:** every code step contains the actual code; every command step the actual command.

- **Type/symbol consistency:** `renderPreview`, `renderFull`, `RenderPreviewResult`, `MemorySummaryWithRelevance`, `FlagResponse`, `index_truncated_count` all use the same names across tasks.
