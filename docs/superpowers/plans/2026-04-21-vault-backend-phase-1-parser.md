# Vault Backend Phase 1 — Parser + Serializer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement pure markdown ⇄ domain-object parsers and serializers for the four vault-backend entity types (Memory, Comment, Flag, Relationship) with property-based roundtrip coverage. No I/O, no git, no vector index — just `string ⇄ object` functions under `src/backend/vault/parser/`.

**Architecture:** Four small parsers, one orchestrator.

- `comment-parser.ts` — Obsidian callout blocks ⇄ `Comment[]`
- `relationship-parser.ts` — Dataview inline-field list ⇄ `Relationship[]`
- `flag-parser.ts` — frontmatter `flags:` array ⇄ `Flag[]`
- `memory-parser.ts` — orchestrates the above plus frontmatter (`gray-matter`) and body sectioning; exposes `parseMemoryFile` / `serializeMemoryFile`

All functions are pure. Roundtrip invariant `parse(serialize(x)) === x` is enforced by `fast-check` property tests plus golden-file fixtures for byte-stability.

**Tech Stack:** TypeScript, `gray-matter` (frontmatter), `fast-check` (property tests), vitest.

**Spec reference:** `docs/superpowers/specs/2026-04-21-vault-backend-design.md` — "Memory file schema", "Components / parser", "Testing / 1. Parser roundtrip".

**Out of scope (later phases):**

- Path resolution (scope ↔ folder) — Phase 2 (`io/paths.ts`)
- Any file I/O — Phase 2
- LanceDB index — Phase 3
- Git ops — Phase 4
- Watcher — Phase 5

---

## File Structure

**Create (source):**

- `src/backend/vault/parser/comment-parser.ts` — `parseCommentSection` / `serializeCommentSection`
- `src/backend/vault/parser/relationship-parser.ts` — `parseRelationshipSection` / `serializeRelationshipSection`
- `src/backend/vault/parser/flag-parser.ts` — `parseFlags` / `serializeFlags` (works on frontmatter value, not string)
- `src/backend/vault/parser/memory-parser.ts` — `parseMemoryFile` / `serializeMemoryFile`; `ParsedMemoryFile` interface

**Create (tests):**

- `tests/unit/backend/vault/parser/comment-parser.test.ts`
- `tests/unit/backend/vault/parser/relationship-parser.test.ts`
- `tests/unit/backend/vault/parser/flag-parser.test.ts`
- `tests/unit/backend/vault/parser/memory-parser.test.ts`
- `tests/unit/backend/vault/parser/roundtrip.property.test.ts`
- `tests/fixtures/vault/memory-minimal.md` — minimal-frontmatter fixture
- `tests/fixtures/vault/memory-full.md` — all-fields fixture (comments, flags, relationships)

**Modify:**

- `package.json` — add `gray-matter` (runtime dep) and `fast-check` (dev dep)

**Unchanged (imported by parser):**

- `src/types/memory.ts` — `Memory`, `Comment`, `MemoryType`, `MemoryScope`
- `src/types/flag.ts` — `Flag`, `FlagType`, `FlagSeverity`
- `src/types/relationship.ts` — `Relationship`, `RelationshipType`

---

## Task 1: Add parser dependencies

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json` (generated)

- [ ] **Step 1: Install runtime and dev deps**

Run:

```bash
npm install gray-matter
npm install --save-dev fast-check
```

Expected: both installed without error. `gray-matter` appears under `dependencies`, `fast-check` under `devDependencies`.

- [ ] **Step 2: Verify they resolve**

Run: `npm run typecheck`
Expected: PASS (no code uses them yet).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add gray-matter and fast-check for vault parser"
```

---

## Task 2: Comment parser (TDD)

Obsidian callout format (from spec):

```markdown
> [!comment] chris · 2026-04-21T11:00:00Z · c_abc
> Confirmed still accurate after April sync.

> [!comment] alice · 2026-04-21T11:30:00Z · c_def
> Added CI check, see PR #42.
```

Header grammar: `> [!comment] {author} · {ISO timestamp} · {id}`. The ISO timestamp is always `YYYY-MM-DDTHH:mm:ss.sssZ` (result of `Date.prototype.toISOString()` — millisecond precision, UTC). Body lines are prefixed `> `; a blank line between callouts separates them.

**Files:**

- Create: `src/backend/vault/parser/comment-parser.ts`
- Create: `tests/unit/backend/vault/parser/comment-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/backend/vault/parser/comment-parser.test.ts
import { describe, it, expect } from "vitest";
import type { Comment } from "../../../../../src/types/memory.js";
import {
  parseCommentSection,
  serializeCommentSection,
} from "../../../../../src/backend/vault/parser/comment-parser.js";

const MEM_ID = "mem_abc123";

describe("parseCommentSection", () => {
  it("returns [] for an empty section", () => {
    expect(parseCommentSection("", MEM_ID)).toEqual([]);
    expect(parseCommentSection("   \n\n  ", MEM_ID)).toEqual([]);
  });

  it("parses a single callout", () => {
    const section = [
      "> [!comment] chris · 2026-04-21T11:00:00.000Z · c_abc",
      "> Confirmed still accurate after April sync.",
    ].join("\n");

    const comments = parseCommentSection(section, MEM_ID);

    expect(comments).toEqual([
      {
        id: "c_abc",
        memory_id: MEM_ID,
        author: "chris",
        content: "Confirmed still accurate after April sync.",
        created_at: new Date("2026-04-21T11:00:00.000Z"),
      },
    ]);
  });

  it("parses multiple callouts separated by a blank line", () => {
    const section = [
      "> [!comment] chris · 2026-04-21T11:00:00.000Z · c_abc",
      "> First.",
      "",
      "> [!comment] alice · 2026-04-21T11:30:00.000Z · c_def",
      "> Second.",
    ].join("\n");

    const comments = parseCommentSection(section, MEM_ID);

    expect(comments).toHaveLength(2);
    expect(comments[0]!.id).toBe("c_abc");
    expect(comments[1]!.id).toBe("c_def");
  });

  it("preserves multi-line content, including internal blank lines", () => {
    const section = [
      "> [!comment] chris · 2026-04-21T11:00:00.000Z · c_abc",
      "> line one",
      ">",
      "> line three",
    ].join("\n");

    const comments = parseCommentSection(section, MEM_ID);

    expect(comments[0]!.content).toBe("line one\n\nline three");
  });
});

describe("serializeCommentSection", () => {
  it("returns an empty string for []", () => {
    expect(serializeCommentSection([])).toBe("");
  });

  it("serializes a single-line comment", () => {
    const c: Comment = {
      id: "c_abc",
      memory_id: MEM_ID,
      author: "chris",
      content: "Confirmed.",
      created_at: new Date("2026-04-21T11:00:00.000Z"),
    };

    expect(serializeCommentSection([c])).toBe(
      [
        "> [!comment] chris · 2026-04-21T11:00:00.000Z · c_abc",
        "> Confirmed.",
      ].join("\n"),
    );
  });

  it("separates multiple comments with a single blank line", () => {
    const a: Comment = {
      id: "c_a",
      memory_id: MEM_ID,
      author: "chris",
      content: "A.",
      created_at: new Date("2026-04-21T11:00:00.000Z"),
    };
    const b: Comment = {
      id: "c_b",
      memory_id: MEM_ID,
      author: "alice",
      content: "B.",
      created_at: new Date("2026-04-21T11:30:00.000Z"),
    };

    expect(serializeCommentSection([a, b])).toBe(
      [
        "> [!comment] chris · 2026-04-21T11:00:00.000Z · c_a",
        "> A.",
        "",
        "> [!comment] alice · 2026-04-21T11:30:00.000Z · c_b",
        "> B.",
      ].join("\n"),
    );
  });

  it("prefixes blank lines in content with a lone '>'", () => {
    const c: Comment = {
      id: "c_abc",
      memory_id: MEM_ID,
      author: "chris",
      content: "line one\n\nline three",
      created_at: new Date("2026-04-21T11:00:00.000Z"),
    };

    expect(serializeCommentSection([c])).toBe(
      [
        "> [!comment] chris · 2026-04-21T11:00:00.000Z · c_abc",
        "> line one",
        ">",
        "> line three",
      ].join("\n"),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/backend/vault/parser/comment-parser.test.ts`
Expected: FAIL with "Cannot find module '...comment-parser.js'".

- [ ] **Step 3: Implement the parser**

```typescript
// src/backend/vault/parser/comment-parser.ts
import type { Comment } from "../../../types/memory.js";

const HEADER_RE =
  /^> \[!comment\] (?<author>.+?) · (?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) · (?<id>\S+)$/;

export function parseCommentSection(
  section: string,
  memoryId: string,
): Comment[] {
  if (section.trim() === "") return [];

  const lines = section.split("\n");
  const comments: Comment[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const header = HEADER_RE.exec(line);
    if (!header) {
      throw new Error(`Invalid comment header at line ${i + 1}: ${line}`);
    }

    const { author, ts, id } = header.groups!;
    const bodyLines: string[] = [];
    i++;

    while (i < lines.length) {
      const bodyLine = lines[i]!;
      if (bodyLine === ">") {
        bodyLines.push("");
        i++;
        continue;
      }
      if (bodyLine.startsWith("> ")) {
        bodyLines.push(bodyLine.slice(2));
        i++;
        continue;
      }
      break;
    }

    comments.push({
      id: id!,
      memory_id: memoryId,
      author: author!,
      content: bodyLines.join("\n"),
      created_at: new Date(ts!),
    });
  }

  return comments;
}

export function serializeCommentSection(comments: Comment[]): string {
  if (comments.length === 0) return "";

  const blocks = comments.map((c) => {
    const header = `> [!comment] ${c.author} · ${c.created_at.toISOString()} · ${c.id}`;
    const body = c.content
      .split("\n")
      .map((l) => (l === "" ? ">" : `> ${l}`))
      .join("\n");
    return `${header}\n${body}`;
  });

  return blocks.join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/backend/vault/parser/comment-parser.test.ts`
Expected: PASS (all six tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/parser/comment-parser.ts tests/unit/backend/vault/parser/comment-parser.test.ts
git commit -m "feat(vault-parser): add comment callout parser/serializer"
```

---

## Task 3: Relationship parser (TDD)

Dataview inline-field format (extending the spec example with the id/timestamp/author fields needed for `Relationship` roundtrip):

```markdown
- supersedes:: [[n_old]] — id: r_abc, confidence: 1.0, by: chris, at: 2026-04-21T10:15:00.000Z, via: consolidation
- related:: [[n_sibling]] — id: r_def, confidence: 0.8, by: alice, at: 2026-04-21T10:20:00.000Z, via: manual, description: "tangentially connected"
```

Grammar:

- `- ` prefix, then `<type>::` (type is `[A-Za-z_][A-Za-z0-9_-]*`), then a single space, then a wikilink `[[<target>]]` (no pipe alias to keep roundtrip exact — aliases are Obsidian display-only).
- An em dash `—` separates the wikilink from a comma-separated key-value meta list.
- Known keys, in fixed emit order: `id`, `confidence`, `by`, `at`, `via`, `description`. `description` is quoted with `"…"`; the quoted value is the last key because commas may appear inside. `via` may be absent (parser treats absence as `null`). `description` absent → emit nothing.
- `confidence` is a number between 0 and 1 inclusive with at most 4 decimal places (parser rounds; serializer trims trailing zeros except for integers which emit as `1` or `0`).

Roundtrip-safety note: parser and serializer together normalise `confidence` to the shortest representation with ≤4 decimals — property tests must use the same normalisation when comparing.

**Files:**

- Create: `src/backend/vault/parser/relationship-parser.ts`
- Create: `tests/unit/backend/vault/parser/relationship-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/backend/vault/parser/relationship-parser.test.ts
import { describe, it, expect } from "vitest";
import type { Relationship } from "../../../../../src/types/relationship.js";
import {
  parseRelationshipSection,
  serializeRelationshipSection,
} from "../../../../../src/backend/vault/parser/relationship-parser.js";

const CTX = { projectId: "proj_x", sourceId: "mem_src" };

function makeRel(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: "r_abc",
    project_id: "proj_x",
    source_id: "mem_src",
    target_id: "mem_tgt",
    type: "supersedes",
    description: null,
    confidence: 1,
    created_by: "chris",
    created_via: "manual",
    archived_at: null,
    created_at: new Date("2026-04-21T10:15:00.000Z"),
    ...overrides,
  };
}

describe("parseRelationshipSection", () => {
  it("returns [] for empty section", () => {
    expect(parseRelationshipSection("", CTX)).toEqual([]);
    expect(parseRelationshipSection("\n\n", CTX)).toEqual([]);
  });

  it("parses a line with no description", () => {
    const section =
      "- supersedes:: [[mem_tgt]] — id: r_abc, confidence: 1, by: chris, at: 2026-04-21T10:15:00.000Z, via: manual";

    expect(parseRelationshipSection(section, CTX)).toEqual([makeRel()]);
  });

  it("parses a line with description", () => {
    const section =
      '- related:: [[mem_tgt]] — id: r_def, confidence: 0.8, by: alice, at: 2026-04-21T10:20:00.000Z, via: agent-auto, description: "tangentially connected, kinda"';

    expect(parseRelationshipSection(section, CTX)).toEqual([
      makeRel({
        id: "r_def",
        type: "related",
        description: "tangentially connected, kinda",
        confidence: 0.8,
        created_by: "alice",
        created_via: "agent-auto",
        created_at: new Date("2026-04-21T10:20:00.000Z"),
      }),
    ]);
  });

  it("parses a line with no via (treated as null)", () => {
    const section =
      "- refines:: [[mem_tgt]] — id: r_ghi, confidence: 0.5, by: chris, at: 2026-04-21T10:15:00.000Z";

    expect(parseRelationshipSection(section, CTX)[0]!.created_via).toBeNull();
  });

  it("parses multiple lines", () => {
    const section = [
      "- supersedes:: [[mem_a]] — id: r_1, confidence: 1, by: chris, at: 2026-04-21T10:15:00.000Z, via: manual",
      "- related:: [[mem_b]] — id: r_2, confidence: 0.8, by: chris, at: 2026-04-21T10:16:00.000Z, via: manual",
    ].join("\n");

    expect(parseRelationshipSection(section, CTX)).toHaveLength(2);
  });
});

describe("serializeRelationshipSection", () => {
  it("returns empty string for []", () => {
    expect(serializeRelationshipSection([])).toBe("");
  });

  it("serializes without description when null", () => {
    expect(serializeRelationshipSection([makeRel()])).toBe(
      "- supersedes:: [[mem_tgt]] — id: r_abc, confidence: 1, by: chris, at: 2026-04-21T10:15:00.000Z, via: manual",
    );
  });

  it("serializes with description when present", () => {
    const rel = makeRel({
      description: "a, b",
      confidence: 0.8,
      created_via: null,
    });
    expect(serializeRelationshipSection([rel])).toBe(
      '- supersedes:: [[mem_tgt]] — id: r_abc, confidence: 0.8, by: chris, at: 2026-04-21T10:15:00.000Z, description: "a, b"',
    );
  });

  it("emits confidence with up to 4 decimals, trimmed", () => {
    expect(
      serializeRelationshipSection([makeRel({ confidence: 0.12345 })]),
    ).toContain("confidence: 0.1235");
    expect(
      serializeRelationshipSection([makeRel({ confidence: 0.5 })]),
    ).toContain("confidence: 0.5");
    expect(
      serializeRelationshipSection([makeRel({ confidence: 1 })]),
    ).toContain("confidence: 1");
  });

  it("joins multiple relationships with newline", () => {
    const out = serializeRelationshipSection([
      makeRel({ id: "r_1", target_id: "mem_a" }),
      makeRel({ id: "r_2", target_id: "mem_b", type: "related" }),
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/backend/vault/parser/relationship-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

```typescript
// src/backend/vault/parser/relationship-parser.ts
import type { Relationship } from "../../../types/relationship.js";

const LINE_RE =
  /^- (?<type>[A-Za-z_][A-Za-z0-9_-]*):: \[\[(?<target>[^\]|]+)\]\] — (?<meta>.+)$/;

interface ParseCtx {
  projectId: string;
  sourceId: string;
}

export function parseRelationshipSection(
  section: string,
  ctx: ParseCtx,
): Relationship[] {
  if (section.trim() === "") return [];

  const out: Relationship[] = [];
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;

    const m = LINE_RE.exec(line);
    if (!m) throw new Error(`Invalid relationship line: ${line}`);

    const { type, target, meta } = m.groups!;
    const kv = parseMeta(meta!);

    const id = required(kv, "id", line);
    const confidence = Number(required(kv, "confidence", line));
    const createdBy = required(kv, "by", line);
    const createdAt = new Date(required(kv, "at", line));
    const createdVia = kv.get("via") ?? null;
    const description = kv.get("description") ?? null;

    out.push({
      id,
      project_id: ctx.projectId,
      source_id: ctx.sourceId,
      target_id: target!,
      type: type!,
      description,
      confidence,
      created_by: createdBy,
      created_via: createdVia,
      archived_at: null,
      created_at: createdAt,
    });
  }
  return out;
}

export function serializeRelationshipSection(rels: Relationship[]): string {
  if (rels.length === 0) return "";
  return rels.map(serializeOne).join("\n");
}

function serializeOne(r: Relationship): string {
  const parts: string[] = [
    `id: ${r.id}`,
    `confidence: ${formatConfidence(r.confidence)}`,
    `by: ${r.created_by}`,
    `at: ${r.created_at.toISOString()}`,
  ];
  if (r.created_via !== null) parts.push(`via: ${r.created_via}`);
  if (r.description !== null) parts.push(`description: "${r.description}"`);

  return `- ${r.type}:: [[${r.target_id}]] — ${parts.join(", ")}`;
}

function formatConfidence(c: number): string {
  const rounded = Math.round(c * 10_000) / 10_000;
  return String(rounded);
}

function parseMeta(meta: string): Map<string, string> {
  const out = new Map<string, string>();
  const descIdx = meta.indexOf(', description: "');
  let head = meta;
  if (descIdx >= 0) {
    head = meta.slice(0, descIdx);
    const descStart = descIdx + ', description: "'.length;
    const descEnd = meta.lastIndexOf('"');
    if (descEnd <= descStart)
      throw new Error(`Unterminated description in: ${meta}`);
    out.set("description", meta.slice(descStart, descEnd));
  }

  for (const part of head.split(", ")) {
    const colon = part.indexOf(": ");
    if (colon < 0) throw new Error(`Invalid meta fragment: ${part}`);
    out.set(part.slice(0, colon), part.slice(colon + 2));
  }
  return out;
}

function required(kv: Map<string, string>, key: string, line: string): string {
  const v = kv.get(key);
  if (v === undefined) throw new Error(`Missing "${key}" in: ${line}`);
  return v;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/backend/vault/parser/relationship-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/parser/relationship-parser.ts tests/unit/backend/vault/parser/relationship-parser.test.ts
git commit -m "feat(vault-parser): add relationship dataview parser/serializer"
```

---

## Task 4: Flag parser (TDD)

The flag list lives in frontmatter (YAML), so this parser operates on parsed YAML values, not raw strings. Callers give it `unknown` and get back a validated `Flag[]`.

Frontmatter shape:

```yaml
flags:
  - id: f_xyz
    type: verify
    severity: needs_review
    reason: referenced file may be renamed
    related: n_other123
    relationship_id: r_abc
    similarity: 0.91
    created: 2026-04-21T10:20:00Z
    resolved: null
    resolved_by: null
```

Maps to `Flag`:

- `related` → `details.related_memory_id`
- `relationship_id` → `details.relationship_id`
- `similarity` → `details.similarity`
- `reason` → `details.reason`
- `created` → `created_at`
- `resolved` → `resolved_at`
- `resolved_by` → `resolved_by`
- `project_id` / `memory_id` → injected from context, not stored in frontmatter

**Files:**

- Create: `src/backend/vault/parser/flag-parser.ts`
- Create: `tests/unit/backend/vault/parser/flag-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/backend/vault/parser/flag-parser.test.ts
import { describe, it, expect } from "vitest";
import type { Flag } from "../../../../../src/types/flag.js";
import {
  parseFlags,
  serializeFlags,
} from "../../../../../src/backend/vault/parser/flag-parser.js";

const CTX = { projectId: "proj_x", memoryId: "mem_src" };

function makeFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    id: "f_xyz",
    project_id: "proj_x",
    memory_id: "mem_src",
    flag_type: "verify",
    severity: "needs_review",
    details: { reason: "referenced file may be renamed" },
    resolved_at: null,
    resolved_by: null,
    created_at: new Date("2026-04-21T10:20:00.000Z"),
    ...overrides,
  };
}

describe("parseFlags", () => {
  it("returns [] for undefined / null / missing", () => {
    expect(parseFlags(undefined, CTX)).toEqual([]);
    expect(parseFlags(null, CTX)).toEqual([]);
    expect(parseFlags([], CTX)).toEqual([]);
  });

  it("parses a minimal flag (reason only)", () => {
    const raw = [
      {
        id: "f_xyz",
        type: "verify",
        severity: "needs_review",
        reason: "referenced file may be renamed",
        created: "2026-04-21T10:20:00.000Z",
        resolved: null,
        resolved_by: null,
      },
    ];

    expect(parseFlags(raw, CTX)).toEqual([makeFlag()]);
  });

  it("parses an enriched flag (related, relationship_id, similarity)", () => {
    const raw = [
      {
        id: "f_abc",
        type: "duplicate",
        severity: "auto_resolved",
        reason: "near-duplicate",
        related: "mem_other",
        relationship_id: "r_1",
        similarity: 0.91,
        created: "2026-04-21T10:20:00.000Z",
        resolved: "2026-04-21T10:21:00.000Z",
        resolved_by: "chris",
      },
    ];

    expect(parseFlags(raw, CTX)).toEqual([
      makeFlag({
        id: "f_abc",
        flag_type: "duplicate",
        severity: "auto_resolved",
        details: {
          reason: "near-duplicate",
          related_memory_id: "mem_other",
          relationship_id: "r_1",
          similarity: 0.91,
        },
        resolved_at: new Date("2026-04-21T10:21:00.000Z"),
        resolved_by: "chris",
      }),
    ]);
  });

  it("throws on non-array input that is not null/undefined", () => {
    expect(() => parseFlags("not-an-array", CTX)).toThrow(/flags.*array/i);
    expect(() => parseFlags({}, CTX)).toThrow(/flags.*array/i);
  });

  it("throws on unknown flag type", () => {
    const raw = [
      {
        id: "f_1",
        type: "bogus",
        severity: "needs_review",
        reason: "x",
        created: "2026-04-21T10:20:00.000Z",
        resolved: null,
        resolved_by: null,
      },
    ];
    expect(() => parseFlags(raw, CTX)).toThrow(/flag_type/);
  });
});

describe("serializeFlags", () => {
  it("returns [] for empty input", () => {
    expect(serializeFlags([])).toEqual([]);
  });

  it("omits optional detail fields when absent", () => {
    expect(serializeFlags([makeFlag()])).toEqual([
      {
        id: "f_xyz",
        type: "verify",
        severity: "needs_review",
        reason: "referenced file may be renamed",
        created: "2026-04-21T10:20:00.000Z",
        resolved: null,
        resolved_by: null,
      },
    ]);
  });

  it("emits optional detail fields when present", () => {
    const f = makeFlag({
      flag_type: "duplicate",
      details: {
        reason: "near-duplicate",
        related_memory_id: "mem_other",
        relationship_id: "r_1",
        similarity: 0.91,
      },
      resolved_at: new Date("2026-04-21T10:21:00.000Z"),
      resolved_by: "chris",
      severity: "auto_resolved",
    });
    expect(serializeFlags([f])[0]).toMatchObject({
      related: "mem_other",
      relationship_id: "r_1",
      similarity: 0.91,
      resolved: "2026-04-21T10:21:00.000Z",
      resolved_by: "chris",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/backend/vault/parser/flag-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

```typescript
// src/backend/vault/parser/flag-parser.ts
import type { Flag, FlagType, FlagSeverity } from "../../../types/flag.js";

const FLAG_TYPES: FlagType[] = [
  "duplicate",
  "contradiction",
  "override",
  "superseded",
  "verify",
];
const FLAG_SEVERITIES: FlagSeverity[] = ["auto_resolved", "needs_review"];

interface ParseCtx {
  projectId: string;
  memoryId: string;
}

export interface FlagFrontmatter {
  id: string;
  type: FlagType;
  severity: FlagSeverity;
  reason: string;
  related?: string;
  relationship_id?: string;
  similarity?: number;
  created: string;
  resolved: string | null;
  resolved_by: string | null;
}

export function parseFlags(raw: unknown, ctx: ParseCtx): Flag[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("flags frontmatter must be an array");
  }

  return raw.map((entry, i) => parseOne(entry, ctx, i));
}

function parseOne(entry: unknown, ctx: ParseCtx, i: number): Flag {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`flags[${i}] must be an object`);
  }
  const e = entry as Record<string, unknown>;

  const flagType = e.type;
  if (
    typeof flagType !== "string" ||
    !FLAG_TYPES.includes(flagType as FlagType)
  ) {
    throw new Error(`flags[${i}].flag_type invalid: ${String(flagType)}`);
  }
  const severity = e.severity;
  if (
    typeof severity !== "string" ||
    !FLAG_SEVERITIES.includes(severity as FlagSeverity)
  ) {
    throw new Error(`flags[${i}].severity invalid: ${String(severity)}`);
  }

  const id = str(e.id, `flags[${i}].id`);
  const reason = str(e.reason, `flags[${i}].reason`);
  const created = str(e.created, `flags[${i}].created`);
  const resolved = nullableStr(e.resolved, `flags[${i}].resolved`);
  const resolvedBy = nullableStr(e.resolved_by, `flags[${i}].resolved_by`);

  const details: Flag["details"] = { reason };
  if (typeof e.related === "string") details.related_memory_id = e.related;
  if (typeof e.relationship_id === "string")
    details.relationship_id = e.relationship_id;
  if (typeof e.similarity === "number") details.similarity = e.similarity;

  return {
    id,
    project_id: ctx.projectId,
    memory_id: ctx.memoryId,
    flag_type: flagType as FlagType,
    severity: severity as FlagSeverity,
    details,
    resolved_at: resolved === null ? null : new Date(resolved),
    resolved_by: resolvedBy,
    created_at: new Date(created),
  };
}

export function serializeFlags(flags: Flag[]): FlagFrontmatter[] {
  return flags.map((f) => {
    const out: FlagFrontmatter = {
      id: f.id,
      type: f.flag_type,
      severity: f.severity,
      reason: f.details.reason,
      created: f.created_at.toISOString(),
      resolved: f.resolved_at ? f.resolved_at.toISOString() : null,
      resolved_by: f.resolved_by,
    };
    if (f.details.related_memory_id !== undefined)
      out.related = f.details.related_memory_id;
    if (f.details.relationship_id !== undefined)
      out.relationship_id = f.details.relationship_id;
    if (f.details.similarity !== undefined)
      out.similarity = f.details.similarity;
    return out;
  });
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be string`);
  return v;
}

function nullableStr(v: unknown, name: string): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  throw new Error(`${name} must be string or null`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/backend/vault/parser/flag-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/vault/parser/flag-parser.ts tests/unit/backend/vault/parser/flag-parser.test.ts
git commit -m "feat(vault-parser): add flag frontmatter parser/serializer"
```

---

## Task 5: Memory file parser (TDD)

`memory-parser.ts` orchestrates `gray-matter` (frontmatter), body sectioning, and the three sub-parsers into a `ParsedMemoryFile`.

Body structure (after frontmatter split):

```
# <title>

<content paragraphs…>

## Relationships

- …

## Comments

> [!comment] …
```

Rules:

1. The first `# ` heading is the title. It is also in frontmatter; the two must match on parse — if they diverge the file is invalid. On serialize the title is emitted once, from `memory.title`.
2. Content = everything between the title line and the first `## ` heading (or end of file). Trailing whitespace is trimmed; a single blank line after the title is consumed.
3. Sections `## Relationships` and `## Comments` are optional. They appear at most once each and always in that order. Unknown `## ` sections are preserved verbatim as part of `content` (user-added notes don't vanish).
4. `user_id` in frontmatter is not on `Memory` — ignored in Phase 1 (Phase 2 repositories inject it via path). `project_id` is required.
5. `flag/<type>` tag emission: on serialize, every unique `flag_type` in `flags` appends a derived tag `flag/<type>` to `tags` (deduplicated). On parse, any tag matching `/^flag\//` is stripped before returning `memory.tags`.
6. `comment_count`, `flag_count`, `relationship_count`, `last_comment_at` are DERIVED from the parsed sub-arrays — not read from frontmatter on parse; not emitted on serialize.

**Files:**

- Create: `src/backend/vault/parser/memory-parser.ts`
- Create: `tests/unit/backend/vault/parser/memory-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/backend/vault/parser/memory-parser.test.ts
import { describe, it, expect } from "vitest";
import type { Memory } from "../../../../../src/types/memory.js";
import type { Flag } from "../../../../../src/types/flag.js";
import type { Relationship } from "../../../../../src/types/relationship.js";
import type { Comment } from "../../../../../src/types/memory.js";
import {
  parseMemoryFile,
  serializeMemoryFile,
  type ParsedMemoryFile,
} from "../../../../../src/backend/vault/parser/memory-parser.js";

function baseMemory(): Memory {
  return {
    id: "mem_abc",
    project_id: "PERSONAL",
    workspace_id: "agent-brain",
    content: "Body markdown.",
    title: "Title",
    type: "pattern",
    scope: "workspace",
    tags: ["hooks"],
    author: "chris",
    source: "manual",
    session_id: null,
    metadata: {},
    embedding_model: "amazon.titan-embed-text-v2:0",
    embedding_dimensions: 1024,
    version: 1,
    created_at: new Date("2026-04-21T10:15:00.000Z"),
    updated_at: new Date("2026-04-21T10:15:00.000Z"),
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
  };
}

describe("parseMemoryFile / serializeMemoryFile", () => {
  it("roundtrips a minimal file (no sections)", () => {
    const input: ParsedMemoryFile = {
      memory: baseMemory(),
      flags: [],
      comments: [],
      relationships: [],
    };

    const md = serializeMemoryFile(input);
    const parsed = parseMemoryFile(md);

    expect(parsed).toEqual(input);
  });

  it("roundtrips a file with all sections", () => {
    const m = baseMemory();
    const flag: Flag = {
      id: "f_1",
      project_id: m.project_id,
      memory_id: m.id,
      flag_type: "verify",
      severity: "needs_review",
      details: { reason: "check" },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date("2026-04-21T10:20:00.000Z"),
    };
    const comment: Comment = {
      id: "c_1",
      memory_id: m.id,
      author: "chris",
      content: "Hi.",
      created_at: new Date("2026-04-21T11:00:00.000Z"),
    };
    const rel: Relationship = {
      id: "r_1",
      project_id: m.project_id,
      source_id: m.id,
      target_id: "mem_other",
      type: "supersedes",
      description: null,
      confidence: 1,
      created_by: "chris",
      created_via: "manual",
      archived_at: null,
      created_at: new Date("2026-04-21T10:15:00.000Z"),
    };

    const input: ParsedMemoryFile = {
      memory: {
        ...m,
        comment_count: 1,
        flag_count: 1,
        relationship_count: 1,
        last_comment_at: comment.created_at,
      },
      flags: [flag],
      comments: [comment],
      relationships: [rel],
    };

    const md = serializeMemoryFile(input);
    const parsed = parseMemoryFile(md);

    expect(parsed.memory.comment_count).toBe(1);
    expect(parsed.memory.flag_count).toBe(1);
    expect(parsed.memory.relationship_count).toBe(1);
    expect(parsed.memory.last_comment_at?.toISOString()).toBe(
      comment.created_at.toISOString(),
    );

    expect(parsed.flags).toEqual(input.flags);
    expect(parsed.comments).toEqual(input.comments);
    expect(parsed.relationships).toEqual(input.relationships);
    expect(parsed.memory).toEqual(input.memory);
  });

  it("emits flag/<type> tags on serialize and strips them on parse", () => {
    const m = baseMemory();
    const flag: Flag = {
      id: "f_1",
      project_id: m.project_id,
      memory_id: m.id,
      flag_type: "verify",
      severity: "needs_review",
      details: { reason: "x" },
      resolved_at: null,
      resolved_by: null,
      created_at: new Date("2026-04-21T10:20:00.000Z"),
    };
    const md = serializeMemoryFile({
      memory: { ...m, flag_count: 1 },
      flags: [flag],
      comments: [],
      relationships: [],
    });

    expect(md).toContain("flag/verify");

    const parsed = parseMemoryFile(md);
    expect(parsed.memory.tags).toEqual(["hooks"]);
  });

  it("throws when frontmatter title and H1 disagree", () => {
    const m = baseMemory();
    const md = serializeMemoryFile({
      memory: m,
      flags: [],
      comments: [],
      relationships: [],
    }).replace("# Title", "# Something else");

    expect(() => parseMemoryFile(md)).toThrow(/title/i);
  });

  it("preserves unknown ## sections as part of content", () => {
    const m = baseMemory();
    const md = serializeMemoryFile({
      memory: { ...m, content: "Intro.\n\n## Notes\n\nFree-form notes." },
      flags: [],
      comments: [],
      relationships: [],
    });

    const parsed = parseMemoryFile(md);
    expect(parsed.memory.content).toBe(
      "Intro.\n\n## Notes\n\nFree-form notes.",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/backend/vault/parser/memory-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

```typescript
// src/backend/vault/parser/memory-parser.ts
import matter from "gray-matter";
import type {
  Memory,
  MemoryType,
  MemoryScope,
  Comment,
} from "../../../types/memory.js";
import type { Flag } from "../../../types/flag.js";
import type { Relationship } from "../../../types/relationship.js";
import { parseFlags, serializeFlags } from "./flag-parser.js";
import {
  parseCommentSection,
  serializeCommentSection,
} from "./comment-parser.js";
import {
  parseRelationshipSection,
  serializeRelationshipSection,
} from "./relationship-parser.js";

export interface ParsedMemoryFile {
  memory: Memory;
  flags: Flag[];
  comments: Comment[];
  relationships: Relationship[];
}

const MEMORY_TYPES: MemoryType[] = [
  "fact",
  "decision",
  "learning",
  "pattern",
  "preference",
  "architecture",
];
const MEMORY_SCOPES: MemoryScope[] = ["workspace", "user", "project"];

const FLAG_TAG_RE = /^flag\//;

export function parseMemoryFile(md: string): ParsedMemoryFile {
  const { data: fm, content: body } = matter(md);

  const id = str(fm.id, "id");
  const projectId = str(fm.project_id, "project_id");
  const ctx = { projectId, memoryId: id };

  const flags = parseFlags(fm.flags, ctx);

  const { title, content, relationshipSection, commentSection } =
    splitBody(body);

  if (title !== str(fm.title, "title")) {
    throw new Error(
      `title mismatch: frontmatter="${String(fm.title)}" body="# ${title}"`,
    );
  }

  const relationships = parseRelationshipSection(relationshipSection, {
    projectId,
    sourceId: id,
  });
  const comments = parseCommentSection(commentSection, id);

  const tagsRaw = Array.isArray(fm.tags)
    ? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : null;
  const tags =
    tagsRaw === null ? null : tagsRaw.filter((t) => !FLAG_TAG_RE.test(t));

  const lastCommentAt =
    comments.length === 0
      ? null
      : comments
          .map((c) => c.created_at.getTime())
          .reduce((a, b) => Math.max(a, b));

  const memory: Memory = {
    id,
    project_id: projectId,
    workspace_id: nullableStr(fm.workspace_id, "workspace_id"),
    content,
    title,
    type: enumField(fm.type, MEMORY_TYPES, "type"),
    scope: enumField(fm.scope, MEMORY_SCOPES, "scope"),
    tags,
    author: str(fm.author, "author"),
    source: nullableStr(fm.source, "source"),
    session_id: nullableStr(fm.session_id, "session_id"),
    metadata:
      fm.metadata === null || fm.metadata === undefined
        ? null
        : (fm.metadata as Record<string, unknown>),
    embedding_model: nullableStr(fm.embedding_model, "embedding_model"),
    embedding_dimensions:
      fm.embedding_dimensions === null || fm.embedding_dimensions === undefined
        ? null
        : Number(fm.embedding_dimensions),
    version: Number(required(fm.version, "version")),
    created_at: new Date(str(fm.created, "created")),
    updated_at: new Date(str(fm.updated, "updated")),
    verified_at:
      fm.verified === null || fm.verified === undefined
        ? null
        : new Date(String(fm.verified)),
    archived_at:
      fm.archived === null || fm.archived === undefined
        ? null
        : new Date(String(fm.archived)),
    comment_count: comments.length,
    flag_count: flags.length,
    relationship_count: relationships.length,
    last_comment_at: lastCommentAt === null ? null : new Date(lastCommentAt),
    verified_by: nullableStr(fm.verified_by, "verified_by"),
  };

  return { memory, flags, comments, relationships };
}

export function serializeMemoryFile(input: ParsedMemoryFile): string {
  const { memory, flags, comments, relationships } = input;

  const flagTypeTags = Array.from(
    new Set(flags.map((f) => `flag/${f.flag_type}`)),
  );
  const allTags =
    memory.tags === null
      ? flagTypeTags.length === 0
        ? null
        : flagTypeTags
      : [...memory.tags, ...flagTypeTags];

  const fm = {
    id: memory.id,
    title: memory.title,
    type: memory.type,
    scope: memory.scope,
    workspace_id: memory.workspace_id,
    project_id: memory.project_id,
    author: memory.author,
    source: memory.source,
    session_id: memory.session_id,
    tags: allTags,
    version: memory.version,
    created: memory.created_at.toISOString(),
    updated: memory.updated_at.toISOString(),
    verified: memory.verified_at ? memory.verified_at.toISOString() : null,
    verified_by: memory.verified_by,
    archived: memory.archived_at ? memory.archived_at.toISOString() : null,
    embedding_model: memory.embedding_model,
    embedding_dimensions: memory.embedding_dimensions,
    metadata: memory.metadata,
    flags: serializeFlags(flags),
  };

  const parts: string[] = [];
  parts.push(`# ${memory.title}`);
  parts.push("");
  parts.push(memory.content);
  if (relationships.length > 0) {
    parts.push("");
    parts.push("## Relationships");
    parts.push("");
    parts.push(serializeRelationshipSection(relationships));
  }
  if (comments.length > 0) {
    parts.push("");
    parts.push("## Comments");
    parts.push("");
    parts.push(serializeCommentSection(comments));
  }

  return matter.stringify(parts.join("\n"), fm);
}

function splitBody(body: string): {
  title: string;
  content: string;
  relationshipSection: string;
  commentSection: string;
} {
  const lines = body.replace(/^\n+/, "").split("\n");
  if (!lines[0]?.startsWith("# ")) {
    throw new Error("body must start with a '# ' title line");
  }
  const title = lines[0].slice(2).trim();

  let rest = lines.slice(1);
  if (rest[0] === "") rest = rest.slice(1);

  const relIdx = rest.findIndex((l) => l === "## Relationships");
  const comIdx = rest.findIndex((l) => l === "## Comments");

  const indices = [
    { kind: "relationships" as const, idx: relIdx },
    { kind: "comments" as const, idx: comIdx },
  ]
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  if (indices.length === 2 && indices[0]!.kind !== "relationships") {
    throw new Error("## Relationships must come before ## Comments");
  }

  const firstKnown = indices[0]?.idx ?? rest.length;
  const content = rest.slice(0, firstKnown).join("\n").replace(/\n+$/, "");

  function sliceSection(kind: "relationships" | "comments"): string {
    const start = indices.find((x) => x.kind === kind)?.idx;
    if (start === undefined) return "";
    const next = indices.find((x) => x.idx > start)?.idx ?? rest.length;
    return rest
      .slice(start + 1, next)
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  }

  return {
    title,
    content,
    relationshipSection: sliceSection("relationships"),
    commentSection: sliceSection("comments"),
  };
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}

function nullableStr(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  throw new Error(`${name} must be string or null`);
}

function enumField<T extends string>(
  v: unknown,
  options: readonly T[],
  name: string,
): T {
  if (typeof v !== "string" || !options.includes(v as T)) {
    throw new Error(
      `${name} must be one of ${options.join("|")}; got ${String(v)}`,
    );
  }
  return v as T;
}

function required(v: unknown, name: string): unknown {
  if (v === undefined || v === null)
    throw new Error(`${name} is required in frontmatter`);
  return v;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/backend/vault/parser/memory-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + whole-parser run**

Run:

```bash
npm run typecheck
npx vitest run tests/unit/backend/vault/parser/
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/vault/parser/memory-parser.ts tests/unit/backend/vault/parser/memory-parser.test.ts
git commit -m "feat(vault-parser): add memory file parser orchestrator"
```

---

## Task 6: Property-based roundtrip tests

Verifies `parse(serialize(x)) ≡ x` for arbitrary valid inputs. Uses `fast-check` with constrained arbitraries that avoid markdown-significant characters (no escape layer yet; can be added later if authors want arbitrary strings).

**Files:**

- Create: `tests/unit/backend/vault/parser/roundtrip.property.test.ts`

- [ ] **Step 1: Write the property tests**

```typescript
// tests/unit/backend/vault/parser/roundtrip.property.test.ts
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Memory } from "../../../../../src/types/memory.js";
import type {
  Flag,
  FlagType,
  FlagSeverity,
} from "../../../../../src/types/flag.js";
import type { Relationship } from "../../../../../src/types/relationship.js";
import type { Comment } from "../../../../../src/types/memory.js";
import {
  parseMemoryFile,
  serializeMemoryFile,
} from "../../../../../src/backend/vault/parser/memory-parser.js";
import {
  parseCommentSection,
  serializeCommentSection,
} from "../../../../../src/backend/vault/parser/comment-parser.js";
import {
  parseRelationshipSection,
  serializeRelationshipSection,
} from "../../../../../src/backend/vault/parser/relationship-parser.js";
import {
  parseFlags,
  serializeFlags,
} from "../../../../../src/backend/vault/parser/flag-parser.js";

const safeChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,?!:;()".split(
    "",
  ),
);
const safeString = fc.stringOf(safeChar, { minLength: 1, maxLength: 40 });

const bodyChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,?!:;()\n".split(
    "",
  ),
);
const bodyString = fc
  .stringOf(bodyChar, { minLength: 0, maxLength: 200 })
  .filter(
    (s) =>
      !s.startsWith("\n") &&
      !s.endsWith("\n") &&
      !/^##? /m.test(s) &&
      !/^> /m.test(s) &&
      !/^- \w+:: /m.test(s),
  );

const nanoid = fc.stringOf(
  fc.constantFrom(
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split(
      "",
    ),
  ),
  { minLength: 8, maxLength: 21 },
);

const isoDate = fc
  .date({
    noInvalidDate: true,
    min: new Date("2000-01-01"),
    max: new Date("2100-01-01"),
  })
  .map((d) => new Date(d.toISOString()));

const memoryType = fc.constantFrom(
  "fact",
  "decision",
  "learning",
  "pattern",
  "preference",
  "architecture",
);
const memoryScope = fc.constantFrom("workspace", "user", "project");
const flagType = fc.constantFrom(
  "duplicate",
  "contradiction",
  "override",
  "superseded",
  "verify",
) as fc.Arbitrary<FlagType>;
const flagSeverity = fc.constantFrom(
  "auto_resolved",
  "needs_review",
) as fc.Arbitrary<FlagSeverity>;

function commentArb(memoryId: string): fc.Arbitrary<Comment> {
  return fc.record({
    id: nanoid,
    memory_id: fc.constant(memoryId),
    author: safeString,
    content: bodyString,
    created_at: isoDate,
  });
}

function flagArb(projectId: string, memoryId: string): fc.Arbitrary<Flag> {
  return fc.record({
    id: nanoid,
    project_id: fc.constant(projectId),
    memory_id: fc.constant(memoryId),
    flag_type: flagType,
    severity: flagSeverity,
    details: fc.record({
      reason: safeString,
      related_memory_id: fc.option(nanoid, { nil: undefined }),
      relationship_id: fc.option(nanoid, { nil: undefined }),
      similarity: fc.option(
        fc
          .double({ min: 0, max: 1, noNaN: true })
          .map((n) => Math.round(n * 10000) / 10000),
        { nil: undefined },
      ),
    }),
    resolved_at: fc.option(isoDate, { nil: null }),
    resolved_by: fc.option(safeString, { nil: null }),
    created_at: isoDate,
  });
}

function relArb(
  projectId: string,
  sourceId: string,
): fc.Arbitrary<Relationship> {
  const desc = fc.stringOf(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,?!:;()".split(
        "",
      ),
    ),
    { minLength: 1, maxLength: 40 },
  );
  const safeType = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,16}$/);
  return fc.record({
    id: nanoid,
    project_id: fc.constant(projectId),
    source_id: fc.constant(sourceId),
    target_id: nanoid,
    type: safeType,
    description: fc.option(desc, { nil: null }),
    confidence: fc
      .double({ min: 0, max: 1, noNaN: true })
      .map((n) => Math.round(n * 10000) / 10000),
    created_by: safeString,
    created_via: fc.option(safeType, { nil: null }),
    archived_at: fc.constant(null),
    created_at: isoDate,
  });
}

describe("parser roundtrip (property-based)", () => {
  it("comments: parse(serialize(xs)) === xs", () => {
    fc.assert(
      fc.property(
        nanoid.chain((mid) =>
          fc
            .array(commentArb(mid), { maxLength: 5 })
            .map((cs) => ({ mid, cs })),
        ),
        ({ mid, cs }) => {
          const parsed = parseCommentSection(serializeCommentSection(cs), mid);
          expect(parsed).toEqual(cs);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("relationships: parse(serialize(xs)) === xs", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(nanoid, nanoid)
          .chain(([pid, sid]) =>
            fc
              .array(relArb(pid, sid), { maxLength: 5 })
              .map((rs) => ({ pid, sid, rs })),
          ),
        ({ pid, sid, rs }) => {
          const parsed = parseRelationshipSection(
            serializeRelationshipSection(rs),
            { projectId: pid, sourceId: sid },
          );
          expect(parsed).toEqual(rs);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("flags: parseFlags(serializeFlags(xs)) === xs", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(nanoid, nanoid)
          .chain(([pid, mid]) =>
            fc
              .array(flagArb(pid, mid), { maxLength: 5 })
              .map((fs) => ({ pid, mid, fs })),
          ),
        ({ pid, mid, fs }) => {
          const serialised = serializeFlags(fs);
          const parsed = parseFlags(serialised, {
            projectId: pid,
            memoryId: mid,
          });
          expect(parsed).toEqual(fs);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("whole memory file: parse(serialize(x)) preserves domain content", () => {
    const memoryArb = fc.tuple(nanoid, safeString).chain(([id, projectId]) =>
      fc
        .record({
          id: fc.constant(id),
          project_id: fc.constant(projectId),
          workspace_id: fc.option(safeString, { nil: null }),
          content: bodyString,
          title: safeString,
          type: memoryType,
          scope: memoryScope,
          tags: fc.option(fc.array(safeString, { maxLength: 4 }), {
            nil: null,
          }),
          author: safeString,
          source: fc.option(safeString, { nil: null }),
          session_id: fc.option(safeString, { nil: null }),
          metadata: fc.constant({}),
          embedding_model: fc.option(safeString, { nil: null }),
          embedding_dimensions: fc.option(fc.integer({ min: 1, max: 4096 }), {
            nil: null,
          }),
          version: fc.integer({ min: 1, max: 1_000_000 }),
          created_at: isoDate,
          updated_at: isoDate,
          verified_at: fc.option(isoDate, { nil: null }),
          archived_at: fc.option(isoDate, { nil: null }),
          verified_by: fc.option(safeString, { nil: null }),
        })
        .map(
          (fields): Memory => ({
            ...fields,
            comment_count: 0,
            flag_count: 0,
            relationship_count: 0,
            last_comment_at: null,
          }),
        ),
    );

    fc.assert(
      fc.property(
        memoryArb.chain((m) =>
          fc
            .tuple(
              fc.array(commentArb(m.id), { maxLength: 3 }),
              fc.array(relArb(m.project_id, m.id), { maxLength: 3 }),
              fc.array(flagArb(m.project_id, m.id), { maxLength: 3 }),
            )
            .map(([comments, relationships, flags]) => ({
              memory: m,
              comments,
              relationships,
              flags,
            })),
        ),
        (input) => {
          const md = serializeMemoryFile(input);
          const parsed = parseMemoryFile(md);

          expect(parsed.memory.comment_count).toBe(input.comments.length);
          expect(parsed.memory.flag_count).toBe(input.flags.length);
          expect(parsed.memory.relationship_count).toBe(
            input.relationships.length,
          );

          const {
            comment_count: _a,
            flag_count: _b,
            relationship_count: _c,
            last_comment_at: _d,
            ...parsedCore
          } = parsed.memory;
          const {
            comment_count: _e,
            flag_count: _f,
            relationship_count: _g,
            last_comment_at: _h,
            ...inputCore
          } = input.memory;
          expect(parsedCore).toEqual(inputCore);

          expect(parsed.comments).toEqual(input.comments);
          expect(parsed.relationships).toEqual(input.relationships);
          expect(parsed.flags).toEqual(input.flags);
        },
      ),
      { numRuns: 100 },
    );
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/unit/backend/vault/parser/roundtrip.property.test.ts`
Expected: PASS (all four properties).

If any property fails, fast-check prints the minimised counterexample — treat it as a bug in the parser/serialiser and fix the implementation (not the test), unless the counterexample exercises a case the arbitraries were meant to exclude (then tighten the arbitrary).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/backend/vault/parser/roundtrip.property.test.ts
git commit -m "test(vault-parser): add fast-check roundtrip properties"
```

---

## Task 7: Golden-file fixtures

Byte-stable fixtures that lock down the on-disk format. Any change to the serializer that alters byte output must update the fixture, showing up in code review as a diff.

**Files:**

- Create: `tests/fixtures/vault/memory-minimal.md`
- Create: `tests/fixtures/vault/memory-full.md`
- Create: `tests/unit/backend/vault/parser/fixtures.test.ts`

- [ ] **Step 1: Create the minimal fixture**

File path: `tests/fixtures/vault/memory-minimal.md`. The file on disk starts with the `---` line (no HTML comment — that is documentation only in the plan).

```markdown
---
id: mem_min_abc
title: Minimal memory
type: fact
scope: workspace
workspace_id: agent-brain
project_id: PERSONAL
author: chris
source: manual
session_id: null
tags:
  - hooks
version: 1
created: "2026-04-21T10:15:00.000Z"
updated: "2026-04-21T10:15:00.000Z"
verified: null
verified_by: null
archived: null
embedding_model: amazon.titan-embed-text-v2:0
embedding_dimensions: 1024
metadata: {}
flags: []
---

# Minimal memory

Body paragraph. One line.
```

- [ ] **Step 2: Create the full fixture**

File path: `tests/fixtures/vault/memory-full.md`.

```markdown
---
id: mem_full_abc
title: Full example memory
type: pattern
scope: workspace
workspace_id: agent-brain
project_id: PERSONAL
author: chris
source: manual
session_id: null
tags:
  - hooks
  - snippets
  - flag/verify
version: 3
created: "2026-04-21T10:15:00.000Z"
updated: "2026-04-21T11:02:00.000Z"
verified: "2026-04-21T11:02:00.000Z"
verified_by: chris
archived: null
embedding_model: amazon.titan-embed-text-v2:0
embedding_dimensions: 1024
metadata: {}
flags:
  - id: f_xyz
    type: verify
    severity: needs_review
    reason: referenced file may be renamed
    related: mem_other
    similarity: 0.91
    created: "2026-04-21T10:20:00.000Z"
    resolved: null
    resolved_by: null
---

# Full example memory

Body paragraph with two lines.
Second line of body.

## Relationships

- supersedes:: [[mem_old]] — id: r_1, confidence: 1, by: chris, at: 2026-04-21T10:15:00.000Z, via: consolidation
- related:: [[mem_sibling]] — id: r_2, confidence: 0.8, by: alice, at: 2026-04-21T10:20:00.000Z, via: manual

## Comments

> [!comment] chris · 2026-04-21T11:00:00.000Z · c_abc
> Confirmed still accurate after April sync.

> [!comment] alice · 2026-04-21T11:30:00.000Z · c_def
> Added CI check, see PR #42.
```

- [ ] **Step 3: Write the fixture test**

```typescript
// tests/unit/backend/vault/parser/fixtures.test.ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseMemoryFile,
  serializeMemoryFile,
} from "../../../../../src/backend/vault/parser/memory-parser.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/vault",
);

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURE_DIR, name), "utf8");
}

describe("golden fixture: memory-minimal.md", () => {
  it("parses without error", async () => {
    const md = await readFixture("memory-minimal.md");
    const parsed = parseMemoryFile(md);

    expect(parsed.memory.id).toBe("mem_min_abc");
    expect(parsed.memory.title).toBe("Minimal memory");
    expect(parsed.memory.content).toBe("Body paragraph. One line.");
    expect(parsed.flags).toEqual([]);
    expect(parsed.comments).toEqual([]);
    expect(parsed.relationships).toEqual([]);
  });

  it("round-trips byte-for-byte", async () => {
    const md = await readFixture("memory-minimal.md");
    const parsed = parseMemoryFile(md);
    expect(serializeMemoryFile(parsed)).toBe(md);
  });
});

describe("golden fixture: memory-full.md", () => {
  it("parses all sections", async () => {
    const md = await readFixture("memory-full.md");
    const parsed = parseMemoryFile(md);

    expect(parsed.memory.id).toBe("mem_full_abc");
    expect(parsed.flags).toHaveLength(1);
    expect(parsed.relationships).toHaveLength(2);
    expect(parsed.comments).toHaveLength(2);

    expect(parsed.memory.tags).toEqual(["hooks", "snippets"]);
    expect(parsed.memory.flag_count).toBe(1);
    expect(parsed.memory.comment_count).toBe(2);
    expect(parsed.memory.relationship_count).toBe(2);
    expect(parsed.memory.last_comment_at?.toISOString()).toBe(
      "2026-04-21T11:30:00.000Z",
    );
  });

  it("round-trips byte-for-byte", async () => {
    const md = await readFixture("memory-full.md");
    const parsed = parseMemoryFile(md);
    expect(serializeMemoryFile(parsed)).toBe(md);
  });
});
```

- [ ] **Step 4: Run fixture tests**

Run: `npx vitest run tests/unit/backend/vault/parser/fixtures.test.ts`
Expected: PASS.

If the byte-for-byte check fails, the serializer's emitted format differs from the fixture. Decide: is the fixture aspirational (change the serializer) or is the serializer authoritative (update the fixture, reviewing the diff carefully). For Phase 1, prefer the fixture as authoritative — it pins Obsidian-visible output.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/vault/memory-minimal.md tests/fixtures/vault/memory-full.md tests/unit/backend/vault/parser/fixtures.test.ts
git commit -m "test(vault-parser): add golden-file fixtures for byte-stable format"
```

---

## Task 8: Final verification (no commit)

- [ ] **Step 1: Full parser test suite**

Run: `npx vitest run tests/unit/backend/vault/parser/`
Expected: every test PASSes.

- [ ] **Step 2: Whole unit suite (no regressions)**

Run: `npm run test:unit`
Expected: every test PASSes.

- [ ] **Step 3: Lint + typecheck + format**

Run in parallel:

```bash
npm run typecheck
npm run lint
npm run format:check
```

Expected: all pass. If `format:check` fails, run `npm run format` and include the reformatted files in the preceding task commits (amend the last commit or add a separate formatting commit — do NOT mix with logic).

- [ ] **Step 4: Verify no new files outside planned scope**

Run: `git diff --name-only main`
Expected output should include only the files listed in the "Create / Modify" sections above, nothing else.

No commit for this task. It is verification-only.

---

## Acceptance criteria

Phase 1 is DONE when:

1. All four parsers (`comment-parser`, `relationship-parser`, `flag-parser`, `memory-parser`) are implemented with pure `parse`/`serialize` functions.
2. Each parser has both unit tests and fast-check property coverage for roundtrip.
3. Two golden-file fixtures (`memory-minimal.md`, `memory-full.md`) round-trip byte-for-byte through `parseMemoryFile`/`serializeMemoryFile`.
4. `npm run test:unit`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass.
5. No I/O, git, or vector code has been introduced — everything is under `src/backend/vault/parser/`.

Phase 2 (repositories against a local directory) depends on these parsers but is not part of this plan.
