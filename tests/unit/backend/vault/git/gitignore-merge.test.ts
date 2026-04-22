import { describe, it, expect } from "vitest";
import { mergeGitignore } from "../../../../../src/backend/vault/git/gitignore-merge.js";

describe("mergeGitignore", () => {
  const required = [".agent-brain/", "_sessions/", "users/"];

  it("writes all required lines when file is empty", () => {
    expect(mergeGitignore("", required)).toContain(".agent-brain/");
    expect(mergeGitignore("", required)).toContain("users/");
  });

  it("is idempotent — running twice produces the same output", () => {
    const once = mergeGitignore("node_modules\n", required);
    const twice = mergeGitignore(once, required);
    expect(twice).toBe(once);
  });

  it("preserves existing user rules and comments", () => {
    const src = "# my rules\nnode_modules\n*.log\n";
    const out = mergeGitignore(src, required);
    expect(out).toContain("# my rules");
    expect(out).toContain("node_modules");
    expect(out).toContain("*.log");
  });

  it("does not duplicate a rule already present", () => {
    const src = "users/\n";
    const out = mergeGitignore(src, required);
    const occurrences = out
      .split("\n")
      .filter((l) => l.trim() === "users/").length;
    expect(occurrences).toBe(1);
  });

  it("adds a separator block before appended lines when source has content", () => {
    const out = mergeGitignore("foo\n", [".agent-brain/"]);
    expect(out).toMatch(/foo\n+# added by agent-brain\n\.agent-brain\/\n$/);
  });

  it("ends with a trailing newline", () => {
    expect(mergeGitignore("", required).endsWith("\n")).toBe(true);
  });
});
