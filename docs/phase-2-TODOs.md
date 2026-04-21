# Phase 2 TODOs — vault backend

Deferred items from PR #27 (Phase 1 parser) review. All relate to hardening the parser against user-edited / external frontmatter, which becomes reachable once Phase 2 wires repositories and Phase 5 adds the chokidar watcher.

## Parser strictness

- [ ] `memory-parser.ts` — reject `NaN` from `Number(fm.version)` and `Number(fm.embedding_dimensions)`. Add `parseFiniteNumber(v, name)` helper.
- [ ] `memory-parser.ts` — reject `Invalid Date` from `new Date(...)` for `created` / `updated` / `verified` / `archived`. Add `parseIsoDate(s, name)` helper that throws when `isNaN(d.getTime())`.
- [ ] `relationship-parser.ts:29` — validate `confidence` is finite (`Number.isFinite`); current `Number("high")` → `NaN` stored silently.
- [ ] `flag-parser.ts:79,81` — same `Invalid Date` guard for `created` / `resolved`.
- [ ] `memory-parser.ts:88-91` — validate `fm.metadata` is a plain object (reject arrays, primitives). Currently `metadata: 42` passes the `as Record` cast.
- [ ] `flag-parser.ts:67-70` — make ill-typed `related` / `relationship_id` / `similarity` throw instead of silently drop. Currently inconsistent with the strict handling of required fields in the same function.

## Parser ergonomics

- [ ] `flag-parser.ts:50` — error message says `flags[i].flag_type invalid` but the YAML field is `type`. Rename to `flags[i].type invalid`.
- [ ] Extract a shared `parser/types.ts` with a unified `ParseCtx` — currently declared separately in `flag-parser.ts` and `relationship-parser.ts` with different field names (`memoryId` vs `sourceId`).
- [ ] `relationship-parser.ts` — escape `"` in description on serialize, unescape on parse. Current `lastIndexOf('"')` delimiter assumes description contains no literal `"`. User-authored descriptions from MCP tools will eventually contain quotes.

## Documentation in production code

- [ ] `memory-parser.ts:37, 121` — comment the `flag/<type>` derived-tag injection/stripping asymmetry. It is a roundtrip surprise and currently documented only in `roundtrip.property.test.ts`.
- [ ] `relationship-parser.ts:75` — comment `parseMeta`'s hard invariant: description must be the last key, delimited by `', description: "'` and closing `"`, enforced implicitly by `serializeOne`'s field order.
- [ ] `relationship-parser.ts:70` — comment `formatConfidence`'s 4-decimal precision contract (silent precision loss otherwise).
- [ ] `memory-parser.ts:180` — comment why `body.replace(/^\n+/, "")` is load-bearing (`gray-matter` emits a leading newline after frontmatter).

## Test coverage

- [ ] Negative-path tests for parser throws (~12 branches total):
  - `memory-parser.ts` — section ordering violation, missing H1, invalid enum (`type`/`scope`), missing `version`, non-string `workspace_id`.
  - `relationship-parser.ts` — malformed line, missing `id`/`confidence`/`by`/`at`, unterminated description, invalid meta fragment.
  - `flag-parser.ts` — invalid `severity`, non-string `id`/`reason`/`created`, non-object array entries.
  - `comment-parser.ts` — malformed header (missing `·` or ID).
- [ ] Golden fixture covering `tags: null`, populated `metadata`, archived state (`archived_at` non-null).
- [ ] Explicit test for the documented `tags: null` + flags → `tags: []` asymmetry (currently avoided in property test via arbitrary tightening; should be pinned as intentional behavior).

## Unknown section handling

- [ ] `memory-parser.ts::splitBody` — decide: (a) silently fold unknown `## ` sections into `content` (current behavior, documented intent), or (b) throw on unknown H2 to catch typos (`## Relationshps`). Currently indistinguishable from a silent drop bug. Either add a comment asserting (a) is intentional, or flip to (b) and test.
