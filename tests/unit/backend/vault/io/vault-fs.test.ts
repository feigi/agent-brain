import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMarkdown,
  writeMarkdownAtomic,
  deleteMarkdown,
  listMarkdownFiles,
} from "../../../../../src/backend/vault/io/vault-fs.js";

describe("vault-fs", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-fs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writeMarkdownAtomic creates parent dirs and writes content", async () => {
    await writeMarkdownAtomic(root, "a/b/c.md", "# hi\n");
    const read = await readFile(join(root, "a/b/c.md"), "utf8");
    expect(read).toBe("# hi\n");
  });

  it("writeMarkdownAtomic leaves no .tmp siblings on success", async () => {
    await writeMarkdownAtomic(root, "a/b/c.md", "# hi\n");
    const entries = await readdir(join(root, "a/b"));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });

  it("readMarkdown returns file contents", async () => {
    await mkdir(join(root, "x"), { recursive: true });
    await writeFile(join(root, "x/y.md"), "content", "utf8");
    const got = await readMarkdown(root, "x/y.md");
    expect(got).toBe("content");
  });

  it("readMarkdown throws when file missing", async () => {
    await expect(readMarkdown(root, "nope.md")).rejects.toThrow();
  });

  it("deleteMarkdown removes the file", async () => {
    await writeMarkdownAtomic(root, "x/y.md", "c");
    await deleteMarkdown(root, "x/y.md");
    await expect(readMarkdown(root, "x/y.md")).rejects.toThrow();
  });

  it("listMarkdownFiles walks recursively and returns relative .md paths", async () => {
    await writeMarkdownAtomic(root, "a.md", "c");
    await writeMarkdownAtomic(root, "dir/b.md", "c");
    await writeMarkdownAtomic(root, "dir/sub/c.md", "c");
    await writeFile(join(root, "ignore.txt"), "nope");
    const files = await listMarkdownFiles(root);
    expect(files.sort()).toEqual(["a.md", "dir/b.md", "dir/sub/c.md"]);
  });

  it("listMarkdownFiles returns [] for an empty vault", async () => {
    const files = await listMarkdownFiles(root);
    expect(files).toEqual([]);
  });
});
