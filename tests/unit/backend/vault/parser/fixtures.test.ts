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
