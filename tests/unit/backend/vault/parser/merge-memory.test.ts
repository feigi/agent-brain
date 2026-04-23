import { describe, it, expect } from "vitest";
import { mergeMemoryFiles } from "../../../../../src/backend/vault/parser/merge-memory.js";
import { parseMemoryFile } from "../../../../../src/backend/vault/parser/memory-parser.js";

/**
 * Build a minimal valid memory file markdown string.
 * Dates are single-quoted so gray-matter parses them as strings,
 * matching what isoDate() expects. (Bare ISO timestamps are parsed
 * by gray-matter as Date objects, which fails the string type-check.)
 */
const base = (over: Record<string, unknown> = {}) =>
  [
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
    "flags: []",
    "---",
    "",
    `# ${over.title ?? "hello"}`,
    "",
    `${over.content ?? "body"}`,
    "",
  ].join("\n");

const passthroughDiff3 = () => ({ clean: true as const, text: "" });

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
});
