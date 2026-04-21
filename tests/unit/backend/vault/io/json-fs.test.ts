import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readJson,
  writeJsonAtomic,
  appendJsonLine,
  readJsonLines,
} from "../../../../../src/backend/vault/io/json-fs.js";

describe("json-fs", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-json-fs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("readJson returns null for a missing file", async () => {
    expect(await readJson(root, "missing.json")).toBeNull();
  });

  it("writeJsonAtomic + readJson round-trips a value", async () => {
    await writeJsonAtomic(root, "nested/dir/state.json", { a: 1, b: [2, 3] });
    expect(await readJson(root, "nested/dir/state.json")).toEqual({
      a: 1,
      b: [2, 3],
    });
  });

  it("writeJsonAtomic removes the .tmp sibling on success", async () => {
    await writeJsonAtomic(root, "x.json", { ok: true });
    const dir = await readFile(join(root, "x.json"), "utf8");
    expect(JSON.parse(dir)).toEqual({ ok: true });
    // No .tmp file should be left behind.
    await expect(readFile(join(root, "x.json.tmp"), "utf8")).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("appendJsonLine + readJsonLines preserves order", async () => {
    await appendJsonLine(root, "log.jsonl", { i: 1 });
    await appendJsonLine(root, "log.jsonl", { i: 2 });
    await appendJsonLine(root, "log.jsonl", { i: 3 });
    const rows = await readJsonLines<{ i: number }>(root, "log.jsonl");
    expect(rows.map((r) => r.i)).toEqual([1, 2, 3]);
  });

  it("readJsonLines returns [] for missing file", async () => {
    expect(await readJsonLines(root, "missing.jsonl")).toEqual([]);
  });

  it("readJsonLines throws on a malformed line", async () => {
    await writeFile(join(root, "bad.jsonl"), '{"ok":1}\nnot-json\n', "utf8");
    await expect(readJsonLines(root, "bad.jsonl")).rejects.toThrow(
      /invalid JSONL entry at line 2/,
    );
  });
});
