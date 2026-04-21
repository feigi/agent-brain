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
