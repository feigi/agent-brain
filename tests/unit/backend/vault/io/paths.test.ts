import { describe, it, expect } from "vitest";
import {
  memoryPath,
  workspaceMetaPath,
  inferScopeFromPath,
} from "../../../../../src/backend/vault/io/paths.js";

describe("vault paths", () => {
  it("workspace-scope memory: workspaces/<ws>/memories/<id>.md", () => {
    expect(
      memoryPath({
        id: "m1",
        scope: "workspace",
        workspaceId: "agent-brain",
        userId: null,
      }),
    ).toBe("workspaces/agent-brain/memories/m1.md");
  });

  it("project-scope memory: project/memories/<id>.md", () => {
    expect(
      memoryPath({
        id: "m1",
        scope: "project",
        workspaceId: null,
        userId: null,
      }),
    ).toBe("project/memories/m1.md");
  });

  it("user-scope memory: users/<user>/<ws>/<id>.md", () => {
    expect(
      memoryPath({
        id: "m1",
        scope: "user",
        workspaceId: "agent-brain",
        userId: "chris",
      }),
    ).toBe("users/chris/agent-brain/m1.md");
  });

  it("workspace-scope requires workspaceId", () => {
    expect(() =>
      memoryPath({
        id: "m1",
        scope: "workspace",
        workspaceId: null,
        userId: null,
      }),
    ).toThrow(/workspace scope requires workspaceId/);
  });

  it("user-scope requires userId and workspaceId", () => {
    expect(() =>
      memoryPath({
        id: "m1",
        scope: "user",
        workspaceId: null,
        userId: "chris",
      }),
    ).toThrow(/user scope requires workspaceId/);
    expect(() =>
      memoryPath({
        id: "m1",
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

  it("inferScopeFromPath: round-trips memoryPath output", () => {
    const cases = [
      {
        scope: "workspace" as const,
        workspaceId: "ws",
        userId: null,
        id: "m1",
      },
      { scope: "project" as const, workspaceId: null, userId: null, id: "m1" },
      { scope: "user" as const, workspaceId: "ws", userId: "u", id: "m1" },
    ];
    for (const c of cases) {
      const p = memoryPath(c);
      expect(inferScopeFromPath(p)).toEqual({
        scope: c.scope,
        workspaceId: c.workspaceId,
        userId: c.userId,
        id: c.id,
      });
    }
  });

  it("inferScopeFromPath rejects paths outside the known layout", () => {
    expect(inferScopeFromPath("random/file.md")).toBeNull();
    expect(inferScopeFromPath("workspaces/ws/m1.md")).toBeNull(); // missing memories/
  });
});
