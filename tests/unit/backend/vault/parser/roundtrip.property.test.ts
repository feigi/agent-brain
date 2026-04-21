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

// Strip derived fields before comparing memories — parser recomputes these
// from the sub-arrays, so they're not part of the roundtrip contract.
function stripDerived(
  m: Memory,
): Omit<
  Memory,
  "comment_count" | "flag_count" | "relationship_count" | "last_comment_at"
> {
  const {
    comment_count,
    flag_count,
    relationship_count,
    last_comment_at,
    ...rest
  } = m;
  void comment_count;
  void flag_count;
  void relationship_count;
  void last_comment_at;
  return rest;
}

const safeChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,?!:;()".split(
    "",
  ),
);
const safeString = fc.string({ unit: safeChar, minLength: 1, maxLength: 40 });

// Strict variant of `safeString` for values that round-trip through the
// H1 markdown heading (e.g. memory title). The heading line `# <title>`
// is trimmed on parse, so leading/trailing whitespace is not preserved.
const titleString = safeString.filter((s) => s === s.trim() && s.length > 0);

// Subset of safeChar without comma. Use for values that land in the
// relationship meta key-value list (`created_by`), because parseMeta's
// split(", ") would otherwise shred a value containing ", ".
const metaSafeChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.?!:;()".split(
    "",
  ),
);
const metaSafeString = fc.string({
  unit: metaSafeChar,
  minLength: 1,
  maxLength: 40,
});

const bodyChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,?!:;()\n".split(
    "",
  ),
);
const bodyString = fc
  .string({ unit: bodyChar, minLength: 0, maxLength: 200 })
  .filter(
    (s) =>
      !s.startsWith("\n") &&
      !s.endsWith("\n") &&
      !/^##? /m.test(s) &&
      !/^> /m.test(s) &&
      !/^- \w+:: /m.test(s),
  );

const nanoid = fc.string({
  unit: fc.constantFrom(
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split(
      "",
    ),
  ),
  minLength: 8,
  maxLength: 21,
});

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
  // Description may contain commas AND quotes (parser escapes/unescapes '"').
  const desc = fc.string({
    unit: fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,?!:;()\"".split(
        "",
      ),
    ),
    minLength: 1,
    maxLength: 40,
  });
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
    // metaSafeString (no comma) because `created_by` lands in the meta
    // comma-delimited list — parseMeta would split on any embedded ", ".
    created_by: metaSafeString,
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
          title: titleString,
          type: memoryType,
          scope: memoryScope,
          // Must be an array (not null). Parser invariant: when flags
          // are present they inject `flag/<type>` tags into frontmatter,
          // so on roundtrip a `null` input with flags materialises as
          // `[]` (all injected tags stripped by FLAG_TAG_RE). Restrict
          // to arrays to side-step this asymmetric case. Tags must also
          // not collide with the stripped `flag/*` namespace.
          tags: fc.array(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,16}$/), {
            maxLength: 4,
          }),
          author: safeString,
          source: fc.option(safeString, { nil: null }),
          session_id: fc.option(safeString, { nil: null }),
          // Cover all three parser branches: null, empty object, populated object.
          // Keys/values use safeString so YAML stringify+parse round-trips cleanly.
          metadata: fc.oneof(
            fc.constant(null),
            fc.constant({}),
            fc.dictionary(
              fc.stringMatching(/^[a-z_][a-z0-9_]{0,8}$/),
              safeString,
              { maxKeys: 3 },
            ),
          ),
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

          expect(stripDerived(parsed.memory)).toEqual(
            stripDerived(input.memory),
          );

          expect(parsed.comments).toEqual(input.comments);
          expect(parsed.relationships).toEqual(input.relationships);
          expect(parsed.flags).toEqual(input.flags);
        },
      ),
      { numRuns: 100 },
    );
  });
});
