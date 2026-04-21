import { describe, it, expect } from "vitest";
import { claudeTarget } from "../../../scripts/installer/targets/claude.js";

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
    expect(plan.markdownPrepends[0].snippet).toMatch(/^__fromFile:/);
  });

  it("postInstructions include docker-compose command", () => {
    const plan = claudeTarget.plan(repoRoot, home);
    expect(
      plan.postInstructions.some((s) => s.includes("docker compose")),
    ).toBe(true);
  });
});
