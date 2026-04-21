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
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ updated: "nope" })),
    ).toThrow(/updated.*ISO.*date/);
  });

  it("memory verified: invalid date (when present) throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ verified: "bad" })),
    ).toThrow(/verified.*ISO.*date/);
  });

  it("memory archived: invalid date (when present) throws", () => {
    expect(() =>
      parseMemoryFile(wrapMemoryMd({ archived: "bad" })),
    ).toThrow(/archived.*ISO.*date/);
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
});
