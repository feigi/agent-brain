import { describe, it, expect } from "vitest";
import { parseTrailers } from "../../../../../src/backend/vault/git/trailer-parser.js";

describe("parseTrailers", () => {
  it("parses a memory-action commit", () => {
    const msg = [
      "[agent-brain] update: memory-foo",
      "",
      "AB-Action: updated",
      "AB-Memory: mem-123",
      "AB-Actor: alice",
    ].join("\n");
    expect(parseTrailers(msg)).toEqual({
      action: "updated",
      memoryId: "mem-123",
      actor: "alice",
      reason: null,
    });
  });

  it("parses a workspace_upsert commit", () => {
    const msg = [
      "[agent-brain] workspace: ws-1",
      "",
      "AB-Action: workspace_upsert",
      "AB-Workspace: ws-1",
      "AB-Actor: bob",
    ].join("\n");
    expect(parseTrailers(msg)).toEqual({
      action: "workspace_upsert",
      workspaceId: "ws-1",
      actor: "bob",
      reason: null,
    });
  });

  it("parses a reconcile commit (no memory/workspace id)", () => {
    const msg = "reconcile\n\nAB-Action: reconcile\nAB-Actor: system";
    expect(parseTrailers(msg)).toEqual({
      action: "reconcile",
      actor: "system",
      reason: null,
    });
  });

  it("decodes AB-Reason escapes", () => {
    const msg = [
      "archive",
      "",
      "AB-Action: archived",
      "AB-Memory: mem-1",
      "AB-Actor: alice",
      "AB-Reason: line-1\\nline-2\\\\tail",
    ].join("\n");
    const parsed = parseTrailers(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.reason).toBe("line-1\nline-2\\tail");
  });

  it("returns null when AB-Action is absent", () => {
    expect(parseTrailers("random commit")).toBeNull();
    expect(parseTrailers("")).toBeNull();
  });

  it("tolerates leading CRLF line endings", () => {
    const msg =
      "subject\r\n\r\nAB-Action: created\r\nAB-Memory: mem-1\r\nAB-Actor: a";
    expect(parseTrailers(msg)?.action).toBe("created");
  });

  it("returns null for an unknown AB-Action value", () => {
    expect(parseTrailers("x\n\nAB-Action: nonsense\nAB-Actor: a")).toBeNull();
  });

  it("returns null when AB-Actor is absent", () => {
    expect(
      parseTrailers("x\n\nAB-Action: updated\nAB-Memory: mem-1"),
    ).toBeNull();
  });
});
