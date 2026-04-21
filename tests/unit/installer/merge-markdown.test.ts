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
import { prependWithMarkers } from "../../../scripts/installer/merge-markdown.js";
import { makeMarkerId } from "../../../scripts/installer/types.js";

const M = makeMarkerId("agent-brain");

describe("prependWithMarkers", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mergemd-"));
    file = join(dir, "CLAUDE.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates file with wrapped snippet when missing", async () => {
    await prependWithMarkers(file, "hello\n", M, { dryRun: false });
    const content = readFileSync(file, "utf8");
    expect(content).toContain("<!-- agent-brain:start -->");
    expect(content).toContain("hello");
    expect(content).toContain("<!-- agent-brain:end -->");
  });

  it("prepends wrapped snippet when file exists without markers", async () => {
    writeFileSync(file, "# Existing\nuser content\n");
    await prependWithMarkers(file, "snippet body\n", M, {
      dryRun: false,
    });
    const content = readFileSync(file, "utf8");
    expect(content.indexOf("<!-- agent-brain:start -->")).toBe(0);
    expect(content).toContain("snippet body");
    expect(content).toContain("# Existing");
    expect(content.indexOf("# Existing")).toBeGreaterThan(
      content.indexOf("<!-- agent-brain:end -->"),
    );
  });

  it("replaces content between markers on re-run", async () => {
    await prependWithMarkers(file, "v1\n", M, { dryRun: false });
    await prependWithMarkers(file, "v2 updated\n", M, {
      dryRun: false,
    });
    const content = readFileSync(file, "utf8");
    expect(content).toContain("v2 updated");
    expect(content).not.toContain("v1\n");
    const starts = content.match(/<!-- agent-brain:start -->/g) ?? [];
    expect(starts).toHaveLength(1);
  });

  it("preserves content outside markers when replacing", async () => {
    await prependWithMarkers(file, "v1\n", M, { dryRun: false });
    writeFileSync(
      file,
      readFileSync(file, "utf8") + "\n# User section\nuser body\n",
    );
    await prependWithMarkers(file, "v2\n", M, { dryRun: false });
    const content = readFileSync(file, "utf8");
    expect(content).toContain("v2");
    expect(content).toContain("# User section");
    expect(content).toContain("user body");
  });

  it("writes a timestamped .bak on every run; previous backups retained", async () => {
    writeFileSync(file, "original\n");
    await prependWithMarkers(file, "a\n", M, { dryRun: false });

    const first = readdirSync(dir).filter((n) =>
      n.startsWith("CLAUDE.md.bak."),
    );
    expect(first).toHaveLength(1);
    const [firstBak] = first;
    expect(readFileSync(join(dir, firstBak), "utf8")).toBe("original\n");

    await new Promise((r) => setTimeout(r, 1100));
    await prependWithMarkers(file, "b\n", M, { dryRun: false });

    const second = readdirSync(dir).filter((n) =>
      n.startsWith("CLAUDE.md.bak."),
    );
    expect(second.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(dir, firstBak), "utf8")).toBe("original\n");
  });

  it("dryRun does not write", async () => {
    writeFileSync(file, "orig\n");
    await prependWithMarkers(file, "x\n", M, { dryRun: true });
    expect(readFileSync(file, "utf8")).toBe("orig\n");
    const baks = readdirSync(dir).filter((n) => n.startsWith("CLAUDE.md.bak."));
    expect(baks).toHaveLength(0);
  });
});
