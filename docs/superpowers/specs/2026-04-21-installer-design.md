# Installer — Design Spec

**Date:** 2026-04-21
**Status:** Approved (pending user review of this doc)

## Goal

Replace today's manual multi-step integration flow (copy scripts → chmod → merge JSON → paste markdown) with a single installer that wires Agent Brain into a user's Claude Code or GitHub Copilot CLI setup.

## Scope

- Install / uninstall hooks, MCP server config, and agent instructions for **Claude Code** and **GitHub Copilot CLI**.
- User-level only (`~/.claude/`, `~/.copilot/`). Project-level setup is out of scope for v1.
- Print the docker-compose command needed to start the server. Do not execute it.

Out of scope: Cursor / other MCP clients, project-level installs, server lifecycle management, network checks against a running MCP server.

## User-facing surface

Invoked from a cloned repo checkout:

```bash
npm run install:agent
npm run uninstall:agent
```

Both resolve to `tsx scripts/installer/index.ts` (uninstall passes `--uninstall`).

### CLI flags

| Flag                             | Effect                               |
| -------------------------------- | ------------------------------------ |
| `--target=claude\|copilot\|both` | Skip interactive target prompt       |
| `--dry-run`                      | Print planned actions; write nothing |
| `--yes` / `-y`                   | Skip confirmation prompt (CI)        |
| `--uninstall`                    | Teardown mode                        |
| `--help`                         | Usage                                |

Interactive behavior: if `--target` is missing and stdin is a TTY, prompt for target. Otherwise fail with an actionable error.

`--uninstall` combines with `--target` the same way install does; `--target=both` uninstalls both.

With `--target=both`, any preflight failure aborts the whole run before any target is applied — no partial installs across targets. Within a single target, failure mid-apply leaves earlier files in place; re-run is idempotent.

## Layout

```
scripts/installer/
  index.ts              # CLI entry: flag parse, prompt, dispatch
  preflight.ts          # jq present, target dir writable, docker warn
  merge-json.ts         # deep-merge + .bak
  merge-markdown.ts     # marker prepend/replace
  targets/
    claude.ts           # Claude paths + snippet→dest mapping
    copilot.ts          # Copilot paths + snippet→dest mapping
  uninstall.ts          # symmetric teardown per target
```

Source snippets remain in `hooks/claude/` and `hooks/copilot/` — the installer reads them from the repo checkout.

## Target modules

```ts
interface Target {
  name: "claude" | "copilot";
  preflight(): Promise<void>;
  plan(): InstallPlan;
  describe(plan: InstallPlan): string;
}

interface InstallPlan {
  copies: Array<{ src: string; dest: string; mode?: number }>;
  jsonMerges: Array<{ file: string; patch: unknown }>;
  markdownPrepends: Array<{ file: string; snippet: string; marker: string }>;
  postInstructions: string[];
}
```

`plan()` is pure — describes actions without side effects. `apply(plan)` executes them.

### Claude target

- Dest root: `~/.claude/`
- Copies: `hooks/claude/memory-*.sh` → `~/.claude/hooks/` (mode `0755`)
- JSON merge: `hooks/claude/settings-snippet.json` → `~/.claude/settings.json`
- Markdown prepend: `hooks/claude/claude-md-snippet.md` → `~/.claude/CLAUDE.md`, marker id `agent-brain`
- Post-install: print `docker compose -f docker-compose.prod.yml up -d --wait` and the `AGENT_BRAIN_URL` override hint.

### Copilot target

- Dest root: `~/.copilot/`
- Copies: `hooks/copilot/memory-*.sh` → `~/.copilot/hooks/` (mode `0755`)
- JSON merges:
  - `hooks/copilot/mcp-snippet.json` → `~/.copilot/mcp-config.json`
  - `hooks/copilot/hooks.json` → `~/.copilot/hooks/hooks.json`
- Markdown prepend: `hooks/copilot/instructions-snippet.md` → `~/.copilot/copilot-instructions.md`, marker id `agent-brain`
- Post-install: print docker-compose command.

## Shared helpers

### `merge-json.ts`

```ts
mergeJson(file: string, patch: unknown, opts: { dryRun: boolean }): Promise<void>
```

1. If file exists, read + parse. If missing, start from `{}`.
2. Deep-merge `patch` into existing. Arrays concat + dedupe by `JSON.stringify` — this keeps hook-array merges idempotent.
3. If file existed and `${file}.bak` does not: write `.bak` with original bytes. Never overwrite an existing `.bak`.
4. Write merged JSON (2-space indent, trailing newline).
5. `dryRun`: skip steps 3–4; return the diff for display.

Idempotency: re-running with the same patch produces identical output.

### `merge-markdown.ts`

```ts
prependWithMarkers(file: string, snippet: string, markerId: string, opts: { dryRun: boolean }): Promise<void>
```

Markers: `<!-- agent-brain:start -->` / `<!-- agent-brain:end -->`.

1. File exists with markers → replace content between markers in place.
2. File exists without markers → prepend wrapped snippet + blank line, then existing content.
3. File missing → create it with just the wrapped snippet.
4. First run only: write `${file}.bak`.
5. `dryRun`: no writes; return intended content.

### `preflight.ts`

Strict (abort on fail):

- `jq` on `PATH`
- Target base dir (`~/.claude` or `~/.copilot`) is creatable / writable

Warn-only:

- `docker` on `PATH` — non-fatal; installer only prints instructions.

## Data flow

```
index.ts
  ├─ parse flags (node:util parseArgs)
  ├─ resolve target(s):
  │    flag given → use it
  │    stdin TTY  → prompt
  │    else       → fail "specify --target"
  ├─ for each target: preflight()     # all preflights run before any apply;
  │                                    # any failure aborts the whole run
  ├─ for each target:
  │    ├─ plan = target.plan()     # pure
  │    ├─ if dryRun: print describe(plan); continue
  │    ├─ if !yes && TTY: confirm  # summary + y/n
  │    └─ apply(plan):
  │         ├─ copies     → fs.copyFile + chmod
  │         ├─ jsonMerges → mergeJson()
  │         └─ markdowns  → prependWithMarkers()
  └─ print postInstructions
```

### Uninstall

```
per target:
  ├─ delete copied hook scripts (ignore ENOENT)
  ├─ unmerge JSON:
  │    read file → remove agent-brain-owned keys (mcpServers.agent-brain,
  │    hook entries whose command path contains "memory-*.sh") → write
  ├─ strip markdown:
  │    remove content between <!-- agent-brain:start/end --> markers
  └─ print: "docker compose down if you started it"
```

`.bak` files are left in place. Uninstall does not attempt to restore from them — users can inspect manually if desired.

## Error handling

Fail fast. No silent catches. No fallback paths.

**Preflight:**

- `jq` missing → `ERR: jq not found. Install: brew install jq (macOS) or apt install jq (Linux)`
- Target dir not writable → `ERR: ~/.claude not writable. Check permissions.`
- Docker missing → `WARN: docker not found. You'll need it to run the server.` (non-fatal)

**Runtime:**

- Invalid JSON in existing settings → `ERR: ~/.claude/settings.json is invalid JSON. Fix or delete before re-running.` (no partial write)
- Copy failure mid-run → abort; already-written files stay. `ERR: failed at step X. Re-run after fixing.` Re-run is safe because every operation is idempotent.
- Snippet source missing → `ERR: expected file hooks/claude/xxx not found. Run from repo root.`

**Uninstall:** ENOENT on deletes is success. Other errors abort.

**Atomicity:** writes are per-file, not transactional across files. Acceptable because re-run is idempotent.

**Exit codes:** 0 success · 1 preflight fail · 2 runtime fail · 3 user declined confirmation.

## Testing

Vitest (already in repo).

**Unit:**

- `merge-json.test.ts` — merge into empty, merge into existing with foreign keys, idempotent re-run (array dedupe), `.bak` first-run-only, invalid-JSON throw.
- `merge-markdown.test.ts` — create missing, wrap-and-prepend when no markers, replace-between-markers, update snippet content on re-run.

**Integration (tmp dir sandbox, `HOME` pointed at temp):**

- `install-claude.test.ts` — assert files copied, chmod set, settings merged, CLAUDE.md written with markers.
- `install-copilot.test.ts` — same for Copilot (two JSON files + instructions).
- `uninstall.test.ts` — install then uninstall → clean state (minus `.bak`).
- `idempotent.test.ts` — install twice → no duplicate entries, content stable.

**Preflight:** stub `which jq` via PATH manipulation in tmp env.

**Out of scope:** no e2e that starts docker or hits the MCP server.

## Decisions & rationale

- **Node/TS via tsx** — matches existing repo stack; reuse deps; type-safe JSON merge. Running from a cloned checkout means `npm install` has already run.
- **User-level only** — simplifies v1; per-project installs can follow when demand is concrete.
- **Prepend (not append) with markers** — Claude / Copilot read instructions top-down; agent-brain guidance should be visible early.
- **Safe merge + `.bak`** — users commonly have unrelated hooks / MCP servers configured. Preserving foreign keys is mandatory; backup protects against parsing bugs.
- **Print docker command, do not run** — installer stays side-effect-scoped to config files. Starting a daemon is a larger commitment the user should make knowingly.
- **Strict preflight** — fails upfront with a clear remediation instead of surfacing cryptic errors mid-install.
