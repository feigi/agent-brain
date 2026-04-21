import { describe, it, expect } from "vitest";
import { parseMemoryFile } from "../../../../../src/backend/vault/parser/memory-parser.js";
import { parseFlags } from "../../../../../src/backend/vault/parser/flag-parser.js";
import { parseRelationshipSection } from "../../../../../src/backend/vault/parser/relationship-parser.js";

function wrapMemoryMd(frontmatterPatch: Record<string, unknown>): string {
  const base = {
    id: "m1",
    title: "T",
    type: "fact",
    scope: "project",
    workspace_id: null,
    project_id: "p1",
    author: "a",
    source: null,
    session_id: null,
    tags: null,
    version: 1,
    created: "2026-04-21T00:00:00.000Z",
    updated: "2026-04-21T00:00:00.000Z",
    verified: null,
    verified_by: null,
    archived: null,
    embedding_model: null,
    embedding_dimensions: null,
    metadata: null,
    flags: [],
  };
  const fm = { ...base, ...frontmatterPatch };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n# T\n\nbody\n`;
}

describe("parser negative paths — number/date finiteness", () => {
  it("memory version: NaN throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ version: "not-a-number" })),
    ).toThrow(/version.*finite/);
  });

  it("memory embedding_dimensions: NaN throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ embedding_dimensions: "abc" })),
    ).toThrow(/embedding_dimensions.*finite/);
  });

  it("memory created: invalid date throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ created: "not-a-date" })),
    ).toThrow(/created.*ISO.*date/);
  });

  it("memory updated: invalid date throws", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ updated: "nope" }))).toThrow(
      /updated.*ISO.*date/,
    );
  });

  it("memory verified: invalid date (when present) throws", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ verified: "bad" }))).toThrow(
      /verified.*ISO.*date/,
    );
  });

  it("memory archived: invalid date (when present) throws", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ archived: "bad" }))).toThrow(
      /archived.*ISO.*date/,
    );
  });

  it("flag created: invalid date throws", () => {
    const badFlag = {
      id: "f1",
      type: "verify",
      severity: "needs_review",
      reason: "r",
      created: "not-iso",
      resolved: null,
      resolved_by: null,
    };
    expect(() =>
      parseFlags([badFlag], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\].created.*ISO.*date/);
  });

  it("flag resolved (non-null): invalid date throws", () => {
    const badFlag = {
      id: "f1",
      type: "verify",
      severity: "needs_review",
      reason: "r",
      created: "2026-04-21T00:00:00.000Z",
      resolved: "garbage",
      resolved_by: "x",
    };
    expect(() =>
      parseFlags([badFlag], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\].resolved.*ISO.*date/);
  });

  it("relationship confidence: non-finite throws", () => {
    const line = `- related:: [[t1]] — id: r1, confidence: high, by: u, at: 2026-04-21T00:00:00.000Z`;
    expect(() =>
      parseRelationshipSection(line, { projectId: "p", sourceId: "s" }),
    ).toThrow(/confidence.*finite/);
  });

  it("memory metadata: array rejected", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ metadata: [1, 2] }))).toThrow(
      /metadata must be an object/,
    );
  });

  it("memory metadata: primitive rejected", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ metadata: 42 }))).toThrow(
      /metadata must be an object/,
    );
  });

  it("flag related: non-string rejected", () => {
    const bad = {
      id: "f1",
      type: "verify",
      severity: "needs_review",
      reason: "r",
      related: 123,
      created: "2026-04-21T00:00:00.000Z",
      resolved: null,
      resolved_by: null,
    };
    expect(() => parseFlags([bad], { projectId: "p", memoryId: "m" })).toThrow(
      /flags\[0\].related must be string/,
    );
  });

  it("flag similarity: string rejected", () => {
    const bad = {
      id: "f1",
      type: "verify",
      severity: "needs_review",
      reason: "r",
      similarity: "high",
      created: "2026-04-21T00:00:00.000Z",
      resolved: null,
      resolved_by: null,
    };
    expect(() => parseFlags([bad], { projectId: "p", memoryId: "m" })).toThrow(
      /flags\[0\].similarity must be a finite number/,
    );
  });

  it("flag type invalid: error message uses 'type' not 'flag_type'", () => {
    const bad = {
      id: "f1",
      type: "bogus",
      severity: "needs_review",
      reason: "r",
      created: "2026-04-21T00:00:00.000Z",
      resolved: null,
      resolved_by: null,
    };
    expect(() => parseFlags([bad], { projectId: "p", memoryId: "m" })).toThrow(
      /flags\[0\]\.type invalid/,
    );
  });

  it("relationship description with embedded quote: roundtrips escaped", () => {
    const line = `- related:: [[t1]] — id: r1, confidence: 1, by: u, at: 2026-04-21T00:00:00.000Z, description: "he said \\"hi\\""`;
    const rels = parseRelationshipSection(line, {
      projectId: "p",
      sourceId: "s",
    });
    expect(rels[0].description).toBe('he said "hi"');
  });

  it("memory: section ordering violation (Comments before Relationships) throws", () => {
    const md = `---\nid: m1\ntitle: T\ntype: fact\nscope: project\nworkspace_id: null\nproject_id: p\nauthor: a\nsource: null\nsession_id: null\ntags: null\nversion: 1\ncreated: "2026-04-21T00:00:00.000Z"\nupdated: "2026-04-21T00:00:00.000Z"\nverified: null\nverified_by: null\narchived: null\nembedding_model: null\nembedding_dimensions: null\nmetadata: null\nflags: []\n---\n\n# T\n\nbody\n\n## Comments\n\n> [!comment] a · 2026-04-21T00:00:00.000Z · c1\n> hi\n\n## Relationships\n\n- related:: [[x]] — id: r, confidence: 1, by: a, at: 2026-04-21T00:00:00.000Z\n`;
    expect(() => parseMemoryFile(md)).toThrow(
      /Relationships.*before.*Comments/,
    );
  });

  it("memory: missing H1 throws", () => {
    const md = `---\nid: m1\ntitle: T\ntype: fact\nscope: project\nworkspace_id: null\nproject_id: p\nauthor: a\nsource: null\nsession_id: null\ntags: null\nversion: 1\ncreated: "2026-04-21T00:00:00.000Z"\nupdated: "2026-04-21T00:00:00.000Z"\nverified: null\nverified_by: null\narchived: null\nembedding_model: null\nembedding_dimensions: null\nmetadata: null\nflags: []\n---\n\nno heading here\n`;
    expect(() => parseMemoryFile(md)).toThrow(/title line/);
  });

  it("memory: invalid type enum throws", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ type: "idea" }))).toThrow(
      /type.*fact.*decision.*learning.*pattern.*preference.*architecture/,
    );
  });

  it("memory: invalid scope enum throws", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ scope: "team" }))).toThrow(
      /scope.*workspace.*user.*project/,
    );
  });

  it("memory: missing version throws", () => {
    const md = wrapMemoryMd({}).replace(/version: 1\n/, "");
    expect(() => parseMemoryFile(md)).toThrow(/version.*required/);
  });

  it("memory: non-string workspace_id throws", () => {
    expect(() => parseMemoryFile(wrapMemoryMd({ workspace_id: 42 }))).toThrow(
      /workspace_id must be string or null/,
    );
  });

  it("relationship: malformed line throws", () => {
    expect(() =>
      parseRelationshipSection("- not a valid line", {
        projectId: "p",
        sourceId: "s",
      }),
    ).toThrow(/Invalid relationship line/);
  });

  it("relationship: missing id throws", () => {
    const line = `- related:: [[t]] — confidence: 1, by: a, at: 2026-04-21T00:00:00.000Z`;
    expect(() =>
      parseRelationshipSection(line, { projectId: "p", sourceId: "s" }),
    ).toThrow(/Missing "id"/);
  });

  it("relationship: unterminated description throws", () => {
    const line = `- related:: [[t]] — id: r, confidence: 1, by: a, at: 2026-04-21T00:00:00.000Z, description: "no end quote`;
    expect(() =>
      parseRelationshipSection(line, { projectId: "p", sourceId: "s" }),
    ).toThrow(/Unterminated description/);
  });

  it("flag: invalid severity throws", () => {
    const bad = {
      id: "f1",
      type: "verify",
      severity: "CRITICAL",
      reason: "r",
      created: "2026-04-21T00:00:00.000Z",
      resolved: null,
      resolved_by: null,
    };
    expect(() => parseFlags([bad], { projectId: "p", memoryId: "m" })).toThrow(
      /flags\[0\]\.severity invalid/,
    );
  });

  it("flag: non-object entry throws", () => {
    expect(() =>
      parseFlags(["not-an-object"], { projectId: "p", memoryId: "m" }),
    ).toThrow(/flags\[0\] must be an object/);
  });
});
