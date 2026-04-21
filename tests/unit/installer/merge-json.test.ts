import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeJson } from "../../../scripts/installer/merge-json.js";

describe("mergeJson", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mergejson-"));
    file = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates file from {} when missing", async () => {
    await mergeJson(
      file,
      { mcpServers: { "agent-brain": { url: "u" } } },
      { dryRun: false },
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpServers: { "agent-brain": { url: "u" } },
    });
  });

  it("preserves foreign keys in existing file", async () => {
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { other: { url: "x" } }, theme: "dark" }),
    );
    await mergeJson(
      file,
      { mcpServers: { "agent-brain": { url: "u" } } },
      { dryRun: false },
    );
    const result = JSON.parse(readFileSync(file, "utf8"));
    expect(result).toEqual({
      mcpServers: { other: { url: "x" }, "agent-brain": { url: "u" } },
      theme: "dark",
    });
  });

  it("is idempotent on re-run (array dedupe by JSON.stringify)", async () => {
    const patch = {
      hooks: { SessionStart: [{ type: "command", command: "x" }] },
    };
    await mergeJson(file, patch, { dryRun: false });
    await mergeJson(file, patch, { dryRun: false });
    const result = JSON.parse(readFileSync(file, "utf8"));
    expect(result.hooks.SessionStart).toHaveLength(1);
  });

  it("writes a timestamped .bak on every run; previous backups retained", async () => {
    writeFileSync(file, JSON.stringify({ original: true }));
    await mergeJson(file, { added: 1 }, { dryRun: false });

    const baksAfterFirst = readdirSync(dir).filter((n) =>
      n.startsWith("settings.json.bak."),
    );
    expect(baksAfterFirst).toHaveLength(1);
    const [firstBak] = baksAfterFirst;
    expect(JSON.parse(readFileSync(join(dir, firstBak), "utf8"))).toEqual({
      original: true,
    });

    await new Promise((r) => setTimeout(r, 1100));
    await mergeJson(file, { added: 2 }, { dryRun: false });

    const baksAfterSecond = readdirSync(dir).filter((n) =>
      n.startsWith("settings.json.bak."),
    );
    expect(baksAfterSecond.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readFileSync(join(dir, firstBak), "utf8"))).toEqual({
      original: true,
    });
  });

  it("throws on invalid JSON", async () => {
    writeFileSync(file, "{ not valid json");
    await expect(mergeJson(file, { x: 1 }, { dryRun: false })).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it("dryRun does not write", async () => {
    writeFileSync(file, JSON.stringify({ a: 1 }));
    await mergeJson(file, { b: 2 }, { dryRun: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1 });
    const baks = readdirSync(dir).filter((n) =>
      n.startsWith("settings.json.bak."),
    );
    expect(baks).toHaveLength(0);
  });
});
