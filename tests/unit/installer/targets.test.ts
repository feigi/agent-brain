import { describe, it, expect } from "vitest";
import { claudeTarget } from "../../../scripts/installer/targets/claude.js";
import { copilotTarget } from "../../../scripts/installer/targets/copilot.js";
import { vscodeCopilotTarget } from "../../../scripts/installer/targets/vscode-copilot.js";

describe("claudeTarget.plan", () => {
  const repoRoot = "/repo";
  const home = "/home/u";

  it("has expected copies", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(plan.target).toBe("claude");
    const filenames = plan.copies.map((c) => c.dest.split("/").pop()).sort();
    expect(filenames).toEqual([
      "memory-autofill.sh",
      "memory-guard.sh",
      "memory-nudge.sh",
      "memory-session-review.sh",
      "memory-session-start.sh",
    ]);
    for (const c of plan.copies) {
      expect(c.src.startsWith(`${repoRoot}/hooks/claude/`)).toBe(true);
      expect(c.dest.startsWith(`${home}/.claude/hooks/`)).toBe(true);
      expect(c.mode).toBe(0o755);
    }
  });

  it("has one jsonMerge for settings.json", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(plan.jsonMerges).toHaveLength(1);
    expect(plan.jsonMerges[0].file).toBe("/home/u/.claude/settings.json");
    expect(plan.jsonMerges[0].patch).toBeTypeOf("object");
  });

  it("has one markdownPrepend for CLAUDE.md with agent-brain marker", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(plan.markdownPrepends).toHaveLength(1);
    expect(plan.markdownPrepends[0].file).toBe("/home/u/.claude/CLAUDE.md");
    expect(plan.markdownPrepends[0].markerId).toBe("agent-brain");
    const snippet = plan.markdownPrepends[0].snippet;
    expect(snippet.kind).toBe("file");
    if (snippet.kind === "file") {
      expect(snippet.path).toContain("claude-md-snippet.md");
    }
  });

  it("postInstructions include docker-compose command", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(
      plan.postInstructions.some((s) => s.includes("docker compose")),
    ).toBe(true);
  });
});

describe("copilotTarget.plan", () => {
  const repoRoot = "/repo";
  const home = "/home/u";

  it("copies 3 hook scripts", () => {
    const plan = copilotTarget.plan(repoRoot, home);
    const filenames = plan.copies.map((c) => c.dest.split("/").pop()).sort();
    expect(filenames).toEqual([
      "memory-pretool.sh",
      "memory-session-end.sh",
      "memory-session-start.sh",
    ]);
    for (const c of plan.copies) {
      expect(c.dest.startsWith("/home/u/.copilot/hooks/")).toBe(true);
      expect(c.mode).toBe(0o755);
    }
  });

  it("merges two JSON files: mcp-config.json and hooks/hooks.json", () => {
    const plan = copilotTarget.plan(repoRoot, home);
    const files = plan.jsonMerges.map((m) => m.file).sort();
    expect(files).toEqual([
      "/home/u/.copilot/hooks/hooks.json",
      "/home/u/.copilot/mcp-config.json",
    ]);
  });

  it("prepends copilot-instructions.md with agent-brain marker", () => {
    const plan = copilotTarget.plan(repoRoot, home);
    expect(plan.markdownPrepends).toHaveLength(1);
    expect(plan.markdownPrepends[0].file).toBe(
      "/home/u/.copilot/copilot-instructions.md",
    );
    expect(plan.markdownPrepends[0].markerId).toBe("agent-brain");
    const snippet = plan.markdownPrepends[0].snippet;
    expect(snippet.kind).toBe("file");
    if (snippet.kind === "file") {
      expect(snippet.path).toContain("instructions-snippet.md");
    }
  });

  it("postInstructions include docker-compose command", () => {
    const plan = copilotTarget.plan(repoRoot, home);
    expect(
      plan.postInstructions.some((s) => s.includes("docker compose")),
    ).toBe(true);
  });
});

describe("vscodeCopilotTarget.plan", () => {
  const repoRoot = "/repo";
  const home = "/home/u";

  it("has no copies (no hook scripts)", () => {
    const plan = vscodeCopilotTarget.plan(repoRoot, home);
    expect(plan.target).toBe("vscode-copilot");
    expect(plan.copies).toHaveLength(0);
  });

  it("has one jsonMerge for mcp.json in VS Code user data dir", () => {
    const plan = vscodeCopilotTarget.plan(repoRoot, home);
    expect(plan.jsonMerges).toHaveLength(1);
    expect(plan.jsonMerges[0].file).toContain("mcp.json");
    expect(plan.jsonMerges[0].file).toContain("Code");
    expect(plan.jsonMerges[0].file).toContain("User");
    const patch = plan.jsonMerges[0].patch;
    expect(patch.kind).toBe("file");
    if (patch.kind === "file") {
      expect(patch.path).toContain("mcp-snippet.json");
    }
  });

  it("has no markdownPrepends", () => {
    const plan = vscodeCopilotTarget.plan(repoRoot, home);
    expect(plan.markdownPrepends).toHaveLength(0);
  });

  it("postInstructions include docker-compose command", () => {
    const plan = vscodeCopilotTarget.plan(repoRoot, home);
    expect(
      plan.postInstructions.some((s) => s.includes("docker compose")),
    ).toBe(true);
  });
});
