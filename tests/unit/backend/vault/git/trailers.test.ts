import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatTrailers } from "../../../../../src/backend/vault/git/trailers.js";
import type { CommitTrailer } from "../../../../../src/backend/vault/git/types.js";

describe("formatTrailers", () => {
  it("emits AB-Action + AB-Memory + AB-Actor in order", () => {
    const out = formatTrailers({
      action: "created",
      memoryId: "abc123",
      actor: "alice",
    });
    expect(out).toBe("AB-Action: created\nAB-Memory: abc123\nAB-Actor: alice");
  });

  it("emits AB-Workspace instead of AB-Memory for workspace_upsert", () => {
    const out = formatTrailers({
      action: "workspace_upsert",
      workspaceId: "ws-42",
      actor: "alice",
    });
    expect(out).toBe(
      "AB-Action: workspace_upsert\nAB-Workspace: ws-42\nAB-Actor: alice",
    );
  });

  it("includes AB-Reason when provided, encodes newlines as \\\\n", () => {
    const out = formatTrailers({
      action: "updated",
      memoryId: "abc",
      actor: "bob",
      reason: "first line\nsecond line",
    });
    expect(out).toContain("AB-Reason: first line\\nsecond line");
  });

  it("omits AB-Reason when null or undefined", () => {
    const out = formatTrailers({
      action: "updated",
      memoryId: "abc",
      actor: "bob",
      reason: null,
    });
    expect(out).not.toContain("AB-Reason");
  });

  // Note: CommitTrailer is a discriminated union — `action: "created"` with
  // no `memoryId` and `action: "workspace_upsert"` with no `workspaceId`
  // now fail at compile time, so no runtime-throw tests are needed.

  it("roundtrips through a conservative trailer parser (property)", () => {
    const actionArb = fc.constantFrom(
      "created",
      "updated",
      "archived",
      "verified",
      "commented",
      "flagged",
      "unflagged",
      "related",
      "unrelated",
    );
    const idArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/);
    const actorArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/);
    type MemoryAction = Extract<CommitTrailer, { memoryId: string }>["action"];
    fc.assert(
      fc.property(actionArb, idArb, actorArb, (action, memoryId, actor) => {
        const out = formatTrailers({
          action: action as MemoryAction,
          memoryId,
          actor,
        });
        const lines = out.split("\n");
        const parsed: Record<string, string> = {};
        for (const l of lines) {
          const m = l.match(/^([A-Za-z-]+):\s*(.*)$/);
          if (m) parsed[m[1]] = m[2];
        }
        expect(parsed["AB-Action"]).toBe(action);
        expect(parsed["AB-Memory"]).toBe(memoryId);
        expect(parsed["AB-Actor"]).toBe(actor);
      }),
    );
  });
});
