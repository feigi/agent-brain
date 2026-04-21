import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPlan } from "../../../scripts/installer/apply.js";
import { makeMarkerId } from "../../../scripts/installer/types.js";

describe("Source<T> resolution in applyPlan", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "absrc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves {kind:'file'} patch by reading and parsing JSON", async () => {
    const snippet = join(dir, "snippet.json");
    writeFileSync(snippet, JSON.stringify({ mcpServers: { a: { url: "u" } } }));
    const target = join(dir, "settings.json");

    await applyPlan(
      {
        target: "claude",
        copies: [],
        jsonMerges: [{ file: target, patch: { kind: "file", path: snippet } }],
        markdownPrepends: [],
        postInstructions: [],
      },
      { dryRun: false },
    );

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      mcpServers: { a: { url: "u" } },
    });
  });

  it("resolves {kind:'inline'} patch without reading any file", async () => {
    const target = join(dir, "settings.json");
    await applyPlan(
      {
        target: "claude",
        copies: [],
        jsonMerges: [
          { file: target, patch: { kind: "inline", value: { x: 1 } } },
        ],
        markdownPrepends: [],
        postInstructions: [],
      },
      { dryRun: false },
    );
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ x: 1 });
  });

  it("resolves {kind:'file'} snippet for markdown and writes wrapped body", async () => {
    const snippetPath = join(dir, "snippet.md");
    writeFileSync(snippetPath, "loaded-from-file\n");
    const target = join(dir, "CLAUDE.md");

    await applyPlan(
      {
        target: "claude",
        copies: [],
        jsonMerges: [],
        markdownPrepends: [
          {
            file: target,
            snippet: { kind: "file", path: snippetPath },
            markerId: makeMarkerId("test-marker"),
          },
        ],
        postInstructions: [],
      },
      { dryRun: false },
    );

    const content = readFileSync(target, "utf8");
    expect(content).toContain("<!-- test-marker:start -->");
    expect(content).toContain("loaded-from-file");
    expect(content).not.toContain("__fromFile");
  });

  it("throws with file path context when patch file contains invalid JSON", async () => {
    const snippet = join(dir, "broken.json");
    writeFileSync(snippet, "{ not valid");
    const target = join(dir, "settings.json");

    await expect(
      applyPlan(
        {
          target: "claude",
          copies: [],
          jsonMerges: [
            { file: target, patch: { kind: "file", path: snippet } },
          ],
          markdownPrepends: [],
          postInstructions: [],
        },
        { dryRun: false },
      ),
    ).rejects.toThrow(/broken\.json: invalid JSON/);
    expect(existsSync(target)).toBe(false);
  });
});
