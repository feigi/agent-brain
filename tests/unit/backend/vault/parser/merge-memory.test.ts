import { describe, it, expect } from "vitest";
import { mergeMemoryFiles } from "../../../../../src/backend/vault/parser/merge-memory.js";
import { parseMemoryFile } from "../../../../../src/backend/vault/parser/memory-parser.js";

/**
 * Build a minimal valid memory file markdown string.
 * Dates are single-quoted so gray-matter parses them as strings,
 * matching what isoDate() expects. (Bare ISO timestamps are parsed
 * by gray-matter as Date objects, which fails the string type-check.)
 *
 * Optional overrides:
 *   flags    — raw YAML array string to embed verbatim in frontmatter
 *   body     — raw markdown lines to append after the title line (replaces
 *              the default "body" paragraph and any ## sections)
 */
const base = (over: Record<string, unknown> = {}) => {
  const flagsYaml = over.flags !== undefined ? String(over.flags) : "flags: []";

  const bodyLines: string[] =
    over.body !== undefined
      ? (over.body as string[])
      : [`${over.content ?? "body"}`, ""];

  return [
    "---",
    "id: mem-1",
    "project_id: proj-1",
    "workspace_id: ws-1",
    `title: ${over.title ?? "hello"}`,
    `type: ${over.type ?? "fact"}`,
    `scope: ${over.scope ?? "workspace"}`,
    `tags: ${JSON.stringify(over.tags ?? ["a"])}`,
    `author: ${over.author ?? "alice"}`,
    "source: null",
    "session_id: null",
    `metadata: ${over.metadata === undefined ? "null" : JSON.stringify(over.metadata)}`,
    "embedding_model: null",
    "embedding_dimensions: null",
    `version: ${over.version ?? 1}`,
    `created: '2026-04-01T00:00:00.000Z'`,
    `updated: '${over.updated ?? "2026-04-20T10:00:00.000Z"}'`,
    `verified: ${over.verified && over.verified !== "null" ? `'${String(over.verified)}'` : "null"}`,
    `archived: ${over.archived && over.archived !== "null" ? `'${String(over.archived)}'` : "null"}`,
    `verified_by: ${over.verified_by ? String(over.verified_by) : "null"}`,
    flagsYaml,
    "---",
    "",
    `# ${over.title ?? "hello"}`,
    "",
    ...bodyLines,
  ].join("\n");
};

/**
 * passthroughDiff3: returns the "ours" text unchanged so the clean-diff3
 * path writes the actual content rather than an empty string. This lets
 * tests that don't care about body text pass through cleanly, while the
 * body-content test can verify the returned text is used.
 */
const passthroughDiff3 = (_base: string, ours: string) => ({
  clean: true as const,
  text: ours,
});

describe("mergeMemoryFiles", () => {
  it("returns { ok: true } with union-merged tags", async () => {
    const a = base({ tags: ["a"] });
    const o = base({ tags: ["a", "x"] });
    const t = base({ tags: ["a", "y"] });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    const merged = parseMemoryFile(res.merged).memory;
    expect(merged.tags).toEqual(["a", "x", "y"]);
  });

  it("picks the side with the later updated_at for LWW fields (title)", async () => {
    const a = base({ title: "base" });
    const o = base({ title: "ours", updated: "2026-04-20T10:00:00.000Z" });
    const t = base({ title: "theirs", updated: "2026-04-20T11:00:00.000Z" });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.title).toBe("theirs");
  });

  it("takes max of both updated_at timestamps", async () => {
    const a = base();
    const o = base({ updated: "2026-04-20T10:00:00.000Z" });
    const t = base({ updated: "2026-04-21T00:00:00.000Z" });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.updated_at.toISOString()).toBe(
      "2026-04-21T00:00:00.000Z",
    );
  });

  it("archived_at: once archived, stays", async () => {
    const a = base();
    const o = base({ archived: "2026-04-20T10:00:00.000Z" });
    const t = base({ archived: "null" });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.archived_at?.toISOString()).toBe(
      "2026-04-20T10:00:00.000Z",
    );
  });

  it("rejects on immutable-field divergence (project_id)", async () => {
    const a = base();
    const o = base();
    const t = a.replace("project_id: proj-1", "project_id: proj-X");
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/project_id/);
  });

  it("rejects on immutable-field divergence (id)", async () => {
    const a = base();
    const o = base();
    const t = a.replace("id: mem-1", "id: mem-X");
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/\bid\b/);
  });

  it("rejects on immutable-field divergence (created_at)", async () => {
    const a = base();
    const o = base();
    const t = a.replace(
      "created: '2026-04-01T00:00:00.000Z'",
      "created: '2025-01-01T00:00:00.000Z'",
    );
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/created_at/);
  });

  it("rejects on parse failure of any side", async () => {
    const res = await mergeMemoryFiles(base(), "not markdown", base(), {
      diff3: passthroughDiff3,
    });
    expect(res.ok).toBe(false);
  });

  it("metadata: per-key merge picks the side with later updated_at", async () => {
    const a = base({ metadata: { keep: 1 } });
    const o = base({
      metadata: { keep: 1, ours: "o" },
      updated: "2026-04-20T10:00:00.000Z",
    });
    const t = base({
      metadata: { keep: 1, theirs: "t" },
      updated: "2026-04-20T11:00:00.000Z",
    });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    const mergedMeta = parseMemoryFile(res.merged).memory.metadata;
    expect(mergedMeta).toEqual({ keep: 1, ours: "o", theirs: "t" });
  });

  it("verified_at/verified_by: take the pair with later verified_at", async () => {
    const a = base();
    const o = base({
      verified: "2026-04-19T00:00:00.000Z",
      verified_by: "alice",
    });
    const t = base({
      verified: "2026-04-20T00:00:00.000Z",
      verified_by: "bob",
    });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    const m = parseMemoryFile(res.merged).memory;
    expect(m.verified_at?.toISOString()).toBe("2026-04-20T00:00:00.000Z");
    expect(m.verified_by).toBe("bob");
  });

  it("clean diff3 path uses the returned text", async () => {
    // passthroughDiff3 returns ours; verify that is what ends up in the merged file.
    const a = base({ content: "ancestor-body" });
    const o = base({ content: "ours-body" });
    const t = base({ content: "theirs-body" });
    const res = await mergeMemoryFiles(a, o, t, { diff3: passthroughDiff3 });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.content.trim()).toBe("ours-body");
  });

  it("falls back to LWW when diff3 reports conflict", async () => {
    const a = base({ content: "base-body" });
    const o = base({
      content: "ours-body",
      updated: "2026-04-20T10:00:00.000Z",
    });
    const t = base({
      content: "theirs-body",
      updated: "2026-04-21T00:00:00.000Z",
    });
    const res = await mergeMemoryFiles(a, o, t, {
      diff3: () => ({ clean: false as const }),
    });
    if (!res.ok) throw new Error(res.reason);
    expect(parseMemoryFile(res.merged).memory.content.trim()).toBe(
      "theirs-body",
    );
  });

  // ---------------------------------------------------------------------------
  // Body subsection: Comments
  // ---------------------------------------------------------------------------

  describe("comments", () => {
    /** Build the ## Comments markdown block for one or more comments. */
    const commentBlock = (
      comments: Array<{ id: string; author: string; ts: string; text: string }>,
    ): string =>
      [
        "## Comments",
        "",
        ...comments.map(
          (c) => `> [!comment] ${c.author} · ${c.ts} · ${c.id}\n> ${c.text}`,
        ),
      ].join("\n");

    it("union of comments by id — different comments on each side are both preserved", async () => {
      const comA = {
        id: "com-1",
        author: "alice",
        ts: "2026-04-10T08:00:00.000Z",
        text: "first",
      };
      const comB = {
        id: "com-2",
        author: "bob",
        ts: "2026-04-11T09:00:00.000Z",
        text: "second",
      };

      const makeWithComments = (comments: (typeof comA)[]) =>
        base({
          body:
            comments.length === 0
              ? ["body", ""]
              : ["body", "", commentBlock(comments), ""],
        });

      const ancestor = makeWithComments([]);
      const ours = makeWithComments([comA]);
      const theirs = makeWithComments([comB]);

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { comments: merged, memory } = parseMemoryFile(res.merged);
      // Both comments present
      expect(merged).toHaveLength(2);
      const ids = merged.map((c) => c.id).sort();
      expect(ids).toEqual(["com-1", "com-2"]);

      // Chronological order (ascending created_at)
      expect(merged[0]!.created_at.getTime()).toBeLessThanOrEqual(
        merged[1]!.created_at.getTime(),
      );

      // Derived counts recomputed
      expect(memory.comment_count).toBe(2);
      expect(memory.last_comment_at?.toISOString()).toBe(
        "2026-04-11T09:00:00.000Z",
      );
    });

    it("last_comment_at and comment_count are recomputed from merged comments", async () => {
      const comEarly = {
        id: "com-early",
        author: "alice",
        ts: "2026-04-10T00:00:00.000Z",
        text: "early",
      };
      const comLate = {
        id: "com-late",
        author: "bob",
        ts: "2026-04-20T00:00:00.000Z",
        text: "late",
      };

      const withComments = (comments: (typeof comEarly)[]) =>
        base({
          body:
            comments.length === 0
              ? ["body", ""]
              : ["body", "", commentBlock(comments), ""],
        });

      const ancestor = withComments([]);
      const ours = withComments([comEarly]);
      const theirs = withComments([comLate]);

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { memory } = parseMemoryFile(res.merged);
      expect(memory.comment_count).toBe(2);
      expect(memory.last_comment_at?.toISOString()).toBe(
        "2026-04-20T00:00:00.000Z",
      );
    });

    it("comment collision — theirs wins", async () => {
      const comOurs = {
        id: "com-shared",
        author: "alice",
        ts: "2026-04-10T00:00:00.000Z",
        text: "ours version",
      };
      const comTheirs = {
        id: "com-shared",
        author: "alice",
        ts: "2026-04-10T00:00:00.000Z",
        text: "theirs version",
      };

      const withComment = (c: typeof comOurs) =>
        base({ body: ["body", "", commentBlock([c]), ""] });

      const ancestor = base();
      const ours = withComment(comOurs);
      const theirs = withComment(comTheirs);

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { comments: merged } = parseMemoryFile(res.merged);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.content).toBe("theirs version");
    });
  });

  // ---------------------------------------------------------------------------
  // Body subsection: Relationships
  // ---------------------------------------------------------------------------

  describe("relationships", () => {
    /** Inline relationship line matching relationship-parser.ts format. */
    const relLine = (opts: {
      type: string;
      target: string;
      id: string;
      confidence: number;
      by: string;
      at: string;
    }) =>
      `- ${opts.type}:: [[${opts.target}]] — id: ${opts.id}, confidence: ${opts.confidence}, by: ${opts.by}, at: ${opts.at}`;

    it("union of relationships — different entries on each side are both preserved", async () => {
      const relA = {
        type: "overrides",
        target: "mem-2",
        id: "rel-1",
        confidence: 0.9,
        by: "alice",
        at: "2026-04-10T00:00:00.000Z",
      };
      const relB = {
        type: "refines",
        target: "mem-3",
        id: "rel-2",
        confidence: 0.8,
        by: "bob",
        at: "2026-04-11T00:00:00.000Z",
      };

      const withRels = (rels: (typeof relA)[]) =>
        base({
          body:
            rels.length === 0
              ? ["body", ""]
              : ["body", "", "## Relationships", "", ...rels.map(relLine), ""],
        });

      const ancestor = withRels([]);
      const ours = withRels([relA]);
      const theirs = withRels([relB]);

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { relationships: merged, memory } = parseMemoryFile(res.merged);
      expect(merged).toHaveLength(2);
      const ids = merged.map((r) => r.id).sort();
      expect(ids).toEqual(["rel-1", "rel-2"]);
      expect(memory.relationship_count).toBe(2);
    });

    it("relationship collision (same source/target/type) — theirs wins", async () => {
      const relOurs = {
        type: "overrides",
        target: "mem-2",
        id: "rel-ours",
        confidence: 0.7,
        by: "alice",
        at: "2026-04-10T00:00:00.000Z",
      };
      const relTheirs = {
        type: "overrides",
        target: "mem-2",
        id: "rel-theirs",
        confidence: 0.95,
        by: "bob",
        at: "2026-04-11T00:00:00.000Z",
      };

      const withRel = (r: typeof relOurs) =>
        base({
          body: ["body", "", "## Relationships", "", relLine(r), ""],
        });

      const ancestor = base();
      const ours = withRel(relOurs);
      const theirs = withRel(relTheirs);

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { relationships: merged } = parseMemoryFile(res.merged);
      // Collision on (source_id=mem-1, target_id=mem-2, type=overrides) → theirs wins
      expect(merged).toHaveLength(1);
      expect(merged[0]!.id).toBe("rel-theirs");
      expect(merged[0]!.confidence).toBeCloseTo(0.95);
    });

    it("relationship_count recomputed", async () => {
      const relA = {
        type: "overrides",
        target: "mem-2",
        id: "rel-1",
        confidence: 1,
        by: "alice",
        at: "2026-04-10T00:00:00.000Z",
      };
      const relB = {
        type: "refines",
        target: "mem-3",
        id: "rel-2",
        confidence: 1,
        by: "bob",
        at: "2026-04-10T00:00:00.000Z",
      };
      const relC = {
        type: "implements",
        target: "mem-4",
        id: "rel-3",
        confidence: 1,
        by: "carol",
        at: "2026-04-10T00:00:00.000Z",
      };

      const withRels = (rels: (typeof relA)[]) =>
        base({
          body:
            rels.length === 0
              ? ["body", ""]
              : ["body", "", "## Relationships", "", ...rels.map(relLine), ""],
        });

      const ancestor = withRels([relA]);
      const ours = withRels([relA, relB]);
      const theirs = withRels([relA, relC]);

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { memory } = parseMemoryFile(res.merged);
      expect(memory.relationship_count).toBe(3); // rel-1, rel-2, rel-3
    });
  });

  // ---------------------------------------------------------------------------
  // Body subsection: Flags
  // ---------------------------------------------------------------------------

  describe("flags", () => {
    /**
     * Build a flags YAML array string for embedding in the frontmatter.
     * Each flag entry uses the shape expected by flag-parser.ts.
     */
    const flagsYaml = (
      flags: Array<{
        id: string;
        type: string;
        severity: string;
        reason: string;
        created: string;
        resolved?: string;
      }>,
    ): string => {
      if (flags.length === 0) return "flags: []";
      const entries = flags
        .map((f) =>
          [
            "  - id: " + f.id,
            "    type: " + f.type,
            "    severity: " + f.severity,
            "    reason: " + f.reason,
            "    created: '" + f.created + "'",
            "    resolved: " + (f.resolved ? `'${f.resolved}'` : "null"),
            "    resolved_by: null",
          ].join("\n"),
        )
        .join("\n");
      return "flags:\n" + entries;
    };

    it("union of flags by id — different flags on each side are both preserved", async () => {
      const flagA = {
        id: "flag-1",
        type: "duplicate",
        severity: "needs_review",
        reason: "looks like mem-2",
        created: "2026-04-10T00:00:00.000Z",
      };
      const flagB = {
        id: "flag-2",
        type: "verify",
        severity: "needs_review",
        reason: "outdated?",
        created: "2026-04-11T00:00:00.000Z",
      };

      const ancestor = base({ flags: flagsYaml([]) });
      const ours = base({ flags: flagsYaml([flagA]) });
      const theirs = base({ flags: flagsYaml([flagB]) });

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { flags: merged } = parseMemoryFile(res.merged);
      expect(merged).toHaveLength(2);
      const ids = merged.map((f) => f.id).sort();
      expect(ids).toEqual(["flag-1", "flag-2"]);
    });

    it("flag collision (same id) — theirs wins", async () => {
      const flagOurs = {
        id: "flag-shared",
        type: "duplicate",
        severity: "needs_review" as const,
        reason: "ours reason",
        created: "2026-04-10T00:00:00.000Z",
      };
      const flagTheirs = {
        id: "flag-shared",
        type: "verify",
        severity: "needs_review" as const,
        reason: "theirs reason",
        created: "2026-04-10T00:00:00.000Z",
      };

      const ancestor = base({ flags: flagsYaml([]) });
      const ours = base({ flags: flagsYaml([flagOurs]) });
      const theirs = base({ flags: flagsYaml([flagTheirs]) });

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { flags: merged } = parseMemoryFile(res.merged);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.flag_type).toBe("verify");
      expect(merged[0]!.details.reason).toBe("theirs reason");
    });

    it("flag_count = unresolved flags only (one resolved, one open → count = 1)", async () => {
      const flagResolved = {
        id: "flag-resolved",
        type: "duplicate",
        severity: "needs_review" as const,
        reason: "was a dupe",
        created: "2026-04-10T00:00:00.000Z",
        resolved: "2026-04-15T00:00:00.000Z",
      };
      const flagOpen = {
        id: "flag-open",
        type: "verify",
        severity: "needs_review" as const,
        reason: "still open",
        created: "2026-04-11T00:00:00.000Z",
      };

      const ancestor = base({ flags: flagsYaml([]) });
      const ours = base({ flags: flagsYaml([flagResolved]) });
      const theirs = base({ flags: flagsYaml([flagOpen]) });

      const res = await mergeMemoryFiles(ancestor, ours, theirs, {
        diff3: passthroughDiff3,
      });
      if (!res.ok) throw new Error(res.reason);

      const { memory, flags: merged } = parseMemoryFile(res.merged);
      expect(merged).toHaveLength(2);
      // flag_count = unresolved only
      expect(memory.flag_count).toBe(1);
    });
  });
});
