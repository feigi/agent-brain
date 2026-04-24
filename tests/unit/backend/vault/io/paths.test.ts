import { describe, it, expect } from "vitest";
import {
  memoryPath,
  workspaceMetaPath,
  inferScopeFromPath,
  slugify,
} from "../../../../../src/backend/vault/io/paths.js";

describe("vault paths", () => {
  it("workspace-scope memory: workspaces/<ws>/memories/<slug>.md", () => {
    expect(
      memoryPath({
        slug: "my-title",
        scope: "workspace",
        workspaceId: "agent-brain",
        userId: null,
      }),
    ).toBe("workspaces/agent-brain/memories/my-title.md");
  });

  it("project-scope memory: project/memories/<slug>.md", () => {
    expect(
      memoryPath({
        slug: "my-title",
        scope: "project",
        workspaceId: null,
        userId: null,
      }),
    ).toBe("project/memories/my-title.md");
  });

  it("user-scope memory: users/<user>/<ws>/<slug>.md", () => {
    expect(
      memoryPath({
        slug: "my-title",
        scope: "user",
        workspaceId: "agent-brain",
        userId: "chris",
      }),
    ).toBe("users/chris/agent-brain/my-title.md");
  });

  it("workspace-scope requires workspaceId", () => {
    expect(() =>
      memoryPath({
        slug: "my-title",
        scope: "workspace",
        workspaceId: null,
        userId: null,
      }),
    ).toThrow(/workspace scope requires workspaceId/);
  });

  it("user-scope requires userId and workspaceId", () => {
    expect(() =>
      memoryPath({
        slug: "my-title",
        scope: "user",
        workspaceId: null,
        userId: "chris",
      }),
    ).toThrow(/user scope requires workspaceId/);
    expect(() =>
      memoryPath({
        slug: "my-title",
        scope: "user",
        workspaceId: "ws",
        userId: null,
      }),
    ).toThrow(/user scope requires userId/);
  });

  it("workspaceMetaPath: workspaces/<slug>/_workspace.md", () => {
    expect(workspaceMetaPath("agent-brain")).toBe(
      "workspaces/agent-brain/_workspace.md",
    );
  });

  it("inferScopeFromPath: extracts scope location (no id)", () => {
    expect(inferScopeFromPath("workspaces/ws/memories/some-title.md")).toEqual({
      scope: "workspace",
      workspaceId: "ws",
      userId: null,
    });

    expect(inferScopeFromPath("project/memories/some-title.md")).toEqual({
      scope: "project",
      workspaceId: null,
      userId: null,
    });

    expect(inferScopeFromPath("users/u/ws/some-title.md")).toEqual({
      scope: "user",
      workspaceId: "ws",
      userId: "u",
    });
  });

  it("inferScopeFromPath rejects paths outside the known layout", () => {
    expect(inferScopeFromPath("random/file.md")).toBeNull();
    expect(inferScopeFromPath("workspaces/ws/m1.md")).toBeNull(); // missing memories/
  });

  it("memoryPath rejects traversal tokens and path separators in slug", () => {
    for (const bad of ["..", ".", "a/b", "a\\b", "", "a\0b"]) {
      expect(() =>
        memoryPath({
          slug: bad,
          scope: "workspace",
          workspaceId: "ws",
          userId: null,
        }),
      ).toThrow(/invalid slug/);
    }
  });

  it("memoryPath rejects traversal tokens and path separators in workspaceId/userId", () => {
    // Empty string triggers the pre-existing null guard, so skip it here.
    for (const bad of ["..", ".", "a/b", "a\\b", "a\0b"]) {
      expect(() =>
        memoryPath({
          slug: "ok",
          scope: "workspace",
          workspaceId: bad,
          userId: null,
        }),
      ).toThrow(/invalid workspaceId/);
      expect(() =>
        memoryPath({
          slug: "ok",
          scope: "user",
          workspaceId: "ws",
          userId: bad,
        }),
      ).toThrow(/invalid userId/);
    }
  });

  it("workspaceMetaPath rejects traversal tokens and path separators", () => {
    for (const bad of ["..", ".", "a/b", "a\\b", "", "a\0b"]) {
      expect(() => workspaceMetaPath(bad)).toThrow(/invalid slug/);
    }
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("My Title")).toBe("my-title");
  });

  it("strips diacritical marks", () => {
    expect(slugify("café résumé")).toBe("cafe-resume");
  });

  it("collapses non-alphanumeric runs", () => {
    expect(slugify("a---b___c")).toBe("a-b-c");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("returns 'untitled' for empty slugs", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("---")).toBe("untitled");
  });
});
