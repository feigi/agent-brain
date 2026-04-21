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
