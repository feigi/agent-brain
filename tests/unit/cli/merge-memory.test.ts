import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../../src/cli/merge-memory.js";

async function tmp(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "merge-"));
  const p = join(dir, "f.md");
  await writeFile(p, body, "utf8");
  return p;
}

// Dates must be single-quoted so gray-matter parses them as strings.
// Bare ISO timestamps are parsed as Date objects, which fails isoDate().
const memoryMd = (title: string) =>
  [
    "---",
    "id: mem-1",
    "project_id: proj-1",
    "workspace_id: ws-1",
    `title: ${title}`,
    "type: fact",
    "scope: workspace",
    'tags: ["a"]',
    "author: alice",
    "source: null",
    "session_id: null",
    "metadata: null",
    "embedding_model: null",
    "embedding_dimensions: null",
    "version: 1",
    "created: '2026-04-01T00:00:00.000Z'",
    "updated: '2026-04-20T10:00:00.000Z'",
    "verified: null",
    "archived: null",
    "verified_by: null",
    "flags: []",
    "---",
    "",
    `# ${title}`,
    "",
    "body",
    "",
  ].join("\n");

describe("merge-memory CLI run()", () => {
  it("returns 0 and writes merged content to %A", async () => {
    const A = await tmp(memoryMd("ours"));
    const O = await tmp(memoryMd("base"));
    const B = await tmp(memoryMd("theirs"));
    const code = await run([A, O, B]);
    expect(code).toBe(0);
    const out = await readFile(A, "utf8");
    expect(out).toMatch(/title: /);
  });

  it("returns 1 on parse failure", async () => {
    const A = await tmp("not yaml");
    const O = await tmp(memoryMd("x"));
    const B = await tmp(memoryMd("y"));
    expect(await run([A, O, B])).toBe(1);
  });

  it("returns 1 on immutable-field divergence", async () => {
    const A = await tmp(memoryMd("ours"));
    const O = await tmp(memoryMd("base"));
    const theirs = memoryMd("theirs").replace(
      "project_id: proj-1",
      "project_id: proj-X",
    );
    const B = await tmp(theirs);
    expect(await run([A, O, B])).toBe(1);
  });

  it("prints a parse error to stderr on exit 1 (smoke)", async () => {
    const A = await tmp("not yaml");
    const O = await tmp(memoryMd("x"));
    const B = await tmp(memoryMd("y"));
    const errs: unknown[] = [];
    const origErr = console.error;
    console.error = (...args) => {
      errs.push(args);
    };
    try {
      await run([A, O, B]);
    } finally {
      console.error = origErr;
    }
    expect(errs.length).toBeGreaterThan(0);
  });
});
