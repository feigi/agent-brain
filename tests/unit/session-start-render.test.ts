import { describe, it, expect } from "vitest";
import {
  renderPreview,
  renderFull,
} from "../../src/utils/session-start-render.js";
import type { MemorySummaryWithRelevance } from "../../src/types/memory.js";
import type { FlagResponse } from "../../src/types/flag.js";

function mem(
  overrides: Partial<MemorySummaryWithRelevance> = {},
): MemorySummaryWithRelevance {
  return {
    id: "abc123",
    title: "Sample memory title",
    content: "Sample content body",
    type: "fact",
    scope: "workspace",
    author: "alice",
    created_at: new Date("2026-04-25T00:00:00.000Z"),
    updated_at: new Date("2026-04-25T00:00:00.000Z"),
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    relevance: 0.9,
    ...overrides,
  };
}

describe("renderPreview", () => {
  it("emits header, index rows, and search-guidance footer with {{PATH}} placeholder", () => {
    const memories = [
      mem({
        id: "id1",
        title: "First memory",
        scope: "project",
        type: "pattern",
      }),
      mem({
        id: "id2",
        title: "Second memory",
        scope: "workspace",
        type: "fact",
      }),
    ];

    const result = renderPreview(memories);

    expect(result.text).toContain("{{PATH}}");
    expect(result.text).toContain("MUST Read");
    expect(result.text).toContain("- id1 [project] pattern — First memory");
    expect(result.text).toContain("- id2 [workspace] fact — Second memory");
    expect(result.text).toContain("Search guidance");
    expect(result.truncatedCount).toBe(0);
  });

  it("drops lowest-relevance non-project rows when index exceeds budget; never drops project rows", () => {
    const longTitle = "x".repeat(60);
    const memories: MemorySummaryWithRelevance[] = [];
    for (let i = 0; i < 5; i++) {
      memories.push(
        mem({
          id: `proj${i}`,
          title: `${longTitle} project ${i}`,
          scope: "project",
          type: "pattern",
          relevance: 0.1,
        }),
      );
    }
    for (let i = 0; i < 45; i++) {
      memories.push(
        mem({
          id: `ws${i}`,
          title: `${longTitle} workspace ${i}`,
          scope: "workspace",
          type: "fact",
          relevance: 0.9 - i * 0.01,
        }),
      );
    }

    const result = renderPreview(memories, 1500);

    for (let i = 0; i < 5; i++) {
      expect(result.text).toContain(`proj${i} [project]`);
    }
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(result.text).toContain("ws0 [workspace]");
    expect(result.text).not.toContain("ws44 [workspace]");
  });
});

describe("renderFull", () => {
  it("groups memories into sections by scope with relevance-descending order within group", () => {
    const memories: MemorySummaryWithRelevance[] = [
      mem({
        id: "p1",
        title: "Proj A",
        scope: "project",
        relevance: 0.5,
        content: "Body P1",
      }),
      mem({
        id: "w2",
        title: "WS Low",
        scope: "workspace",
        relevance: 0.4,
        content: "Body W2",
      }),
      mem({
        id: "w1",
        title: "WS High",
        scope: "workspace",
        relevance: 0.9,
        content: "Body W1",
      }),
      mem({
        id: "u1",
        title: "User One",
        scope: "user",
        relevance: 0.7,
        content: "Body U1",
      }),
    ];

    const out = renderFull(memories);

    expect(out).toContain("## project rules");
    expect(out).toContain("## workspace memories");
    expect(out).toContain("## user memories");

    expect(out).toContain("## Proj A");
    expect(out).toContain("## WS High");
    expect(out).toContain("## WS Low");
    expect(out).toContain("## User One");

    expect(out).toContain("**id:** p1");
    expect(out).toContain("**scope:** project");
    expect(out).toContain("**type:** fact");

    expect(out).toContain("Body P1");
    expect(out).toContain("Body W1");

    expect(out.indexOf("## WS High")).toBeLessThan(out.indexOf("## WS Low"));
  });

  it("emits a flags section when flags are non-empty, omits it otherwise", () => {
    const m = mem({ id: "m1", title: "T1", scope: "workspace" });
    const withoutFlags = renderFull([m]);
    expect(withoutFlags).not.toContain("## flags");

    const flags: FlagResponse[] = [
      {
        flag_id: "f1",
        flag_type: "verify",
        memory: { id: "m1", title: "T1", content: "C1", scope: "workspace" },
        reason: "stale claim",
      },
    ];
    const withFlags = renderFull([m], flags);
    expect(withFlags).toContain("## flags");
    expect(withFlags).toContain("f1");
    expect(withFlags).toContain("verify");
    expect(withFlags).toContain("stale claim");
  });
});
