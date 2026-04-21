# Installer `.env` bootstrap — Design

**Date:** 2026-04-21
**Status:** Approved, ready for plan
**Related:** [`2026-04-21-installer-design.md`](./2026-04-21-installer-design.md)

## Problem

The current installer (`scripts/installer/`) writes only to `$HOME` (Claude and Copilot configs). It does not help the user set up the repo-root `.env` file that the MCP server reads at startup. After running `npm run install:agent`, a new user still has to copy `.env.example` → `.env` and edit `PROJECT_ID` manually, with no guidance on which `EMBEDDING_PROVIDER` block is relevant. Users who already have an older `.env` get no help when new keys land in `.env.example`.

## Goal

Extend the installer with an `.env` bootstrap / merge step that:

- Creates `.env` from `.env.example` on a fresh checkout, prompting only for values that have no safe default.
- Adds newly introduced keys to an existing `.env` without ever overwriting values the user has set.
- Respects the installer's existing `--dry-run` and `--uninstall` flags.

## Non-goals

- Validating credentials or reachability of external services (AWS, Ollama, Postgres).
- Managing secrets or encrypting `.env`.
- Deleting keys from a user's `.env` that were removed from `.env.example`.
- Replacing the MCP server's own `.env` loader (`dotenv`).

## Behavior

### Trigger rules

- Runs **always**, as part of `runInstaller`, after preflight and before target installation.
- `--dry-run`: prints the merge plan (what would be added / prompted / backed up), performs no writes.
- `--uninstall`: skipped entirely. `.env` is user data and the uninstaller never touches it.
- Runs independently of `--target=claude|copilot|both` — both targets install the MCP server, so `.env` is always relevant.

### Flow

```
.env exists in repo root?
├── no  → fresh bootstrap
│   • prompt PROJECT_ID (required, no default — .env.example placeholder
│     "my-project" is not accepted as a working value)
│   • prompt EMBEDDING_PROVIDER (choice: titan | mock | ollama, default ollama)
│   • render .env from .env.example template
│     - substitute PROJECT_ID and EMBEDDING_PROVIDER with answers
│     - keep .env.example defaults for all other keys
│     - preserve template comments, blank lines, key order
│   • atomicWrite .env (no .bak — file did not exist)
│
└── yes → parse existing .env, diff keys vs .env.example
    • missing keys = (keys in template) \ (keys in existing)
    • if missing is empty:
        no-op, print "✓ .env up to date with .env.example"
    • if missing is non-empty:
        - build merged content:
          walk template in order; for each key line, emit the existing
          value if the key is in existing, otherwise emit the template
          default; preserve template comments and blank lines
        - append any keys present only in existing (not in template)
          at the end under a "# Keys not in .env.example" comment,
          so user extensions survive
        - if merged content differs from existing (byte-compare):
            writeBackup existing → .env.bak
            atomicWrite merged → .env
            print summary: "added N keys: K1, K2, …"
        - else:
            no-op (defensive: parse-normalize could produce same bytes)
```

### Placeholder handling

`.env.example` ships `PROJECT_ID=my-project` as a placeholder. Rules:

- **Fresh install:** the prompt has no default; the user must supply a value. Empty input or `my-project` is rejected with an explanatory error.
- **Existing `.env` with `PROJECT_ID=my-project`:** print a warning, do not overwrite. The user chose "never touch existing values"; this is consistent. Warning text: `warn: PROJECT_ID is still the placeholder 'my-project' in .env — set a real project id before starting the server`.

### Non-TTY behavior

- Fresh install + non-TTY: hard error, same failure mode as target selection in `index.ts`. `PROJECT_ID` has no safe default.
- Existing `.env` + non-TTY: merge proceeds silently; no prompts needed.

## Architecture

### New module: `scripts/installer/env-file.ts`

Single-responsibility module. Pure functions for parse/merge, one orchestrator for side effects.

```ts
// Parsing
type EnvLine =
  | { kind: "kv"; key: string; value: string }
  | { kind: "comment"; raw: string }
  | { kind: "blank" };

// kv lines are always reconstructed on serialize as `${key}=${value}`.
// This lets merge swap values from existing into template-shaped output
// without carrying two representations. Whitespace inside kv lines
// (e.g. `KEY = VALUE`) is not preserved. Comments and blank lines keep
// their exact raw form.

function parseDotenv(text: string): EnvLine[];
// Lenient: accepts KEY=VALUE lines (no quotes, no multiline — matches
// current .env.example). Rejects malformed lines with a clear error
// citing the line number.

// Merging
interface MergeResult {
  lines: EnvLine[]; // merged content in template order
  added: string[]; // keys newly introduced from template
  extras: string[]; // keys in existing but not template (preserved)
  changed: boolean; // true if serialized output != existing input
}

function mergeEnv(existing: EnvLine[], template: EnvLine[]): MergeResult;

function serialize(lines: EnvLine[]): string;

// Interactive prompts
interface FreshAnswers {
  PROJECT_ID: string;
  EMBEDDING_PROVIDER: "titan" | "mock" | "ollama";
}

async function promptFresh(rl: Interface): Promise<FreshAnswers>;

// Orchestrator (side effects)
interface BootstrapOptions {
  dryRun: boolean;
}

interface BootstrapPlan {
  mode: "fresh" | "merge" | "noop";
  added: string[];
  extras: string[];
  willBackup: boolean;
  warnings: string[];
}

async function bootstrapEnv(
  repoRoot: string,
  opts: BootstrapOptions,
): Promise<BootstrapPlan>;
```

### Integration in `scripts/installer/index.ts`

Call site added after preflight, before the target apply loop:

```ts
for (const name of opts.targets) {
  await TARGETS[name].preflight(env.home);
}

if (!opts.uninstall) {
  const plan = await bootstrapEnv(env.repoRoot, { dryRun: opts.dryRun });
  // orchestrator prints its own summary; return value used for tests
}

for (const name of opts.targets) {
  // … unchanged
}
```

### Preflight additions

In a new helper (shared between targets, or inlined in `bootstrapEnv`):

- `.env.example` must exist at `<repoRoot>/.env.example`. Missing → hard error with the path.
- Repo root must be writable. Probe with the same pattern as `preflight.ts:47` (touch a temp file, clean up).

### Reused building blocks

- `fs-util.ts`: `atomicWrite`, `writeBackup`, `fileExists`.
- `readline/promises`: same pattern as `promptTarget` in `index.ts`.

## Data flow

```
        .env.example  ─┐
                       ├─► parseDotenv ─► template: EnvLine[]
        .env (if any) ─┘                  existing: EnvLine[]
                                                 │
                       promptFresh ────────►   fresh answers
                       (fresh branch only)          │
                                                 ▼
                                              mergeEnv
                                                 │
                                                 ▼
                                          serialize + write
                                             (+ .env.bak)
```

## Error handling

- `.env.example` missing → throw with path, no partial state.
- `.env` malformed → throw citing line number; do not attempt repair. User fixes manually, reruns.
- Write failure on `.env.bak` → abort before `.env` write, rethrow.
- Write failure on `.env` → `.env.bak` remains (safe: user can restore manually).
- Non-TTY + fresh install → throw with clear remediation (`set PROJECT_ID env var or run in a TTY`).

## Testing

New file: `tests/unit/installer/env-file.test.ts`.

**Parse:**

- roundtrip: `parseDotenv(s) → serialize` preserves exact bytes for input that uses canonical `KEY=VALUE` form (matches current `.env.example`)
- rejects malformed line with line number in error

**Merge:**

- no existing + template → lines equal template, `added` = all template keys, `changed` true
- existing = template (byte-identical) → `added` empty, `changed` false, `willBackup` false
- existing missing one key → that key appended in template position, `added` = `[key]`, `changed` true
- existing has extra key not in template → extra preserved at end under comment, `extras` = `[key]`
- existing value differs from template for a shared key → existing value wins (never overwrite)

**Orchestrator (integration, tmp dir):**

- fresh (no `.env`): prompts mocked, writes `.env`, no `.bak`
- existing identical: no-op, no writes
- existing missing keys: `.bak` written, `.env` rewritten, summary printed
- `--dry-run`: plan printed, `.env` and `.bak` not touched
- `.env.example` missing: throws
- non-TTY + fresh: throws

## Open questions

None — all resolved in brainstorm (see conversation 2026-04-21).

## Out-of-scope follow-ups

- Validating Ollama reachability / AWS credentials on install (explicitly rejected in brainstorm Q4).
- Managing a `.env` schema version to drive future migrations (e.g. renamed keys).
- Running the bootstrap as a standalone subcommand (`--env-only`).
