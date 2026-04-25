import { describe, it, expect } from "vitest";
import {
  renderPreview,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  renderFull,
} from "../../src/utils/session-start-render.js";
import type { MemorySummaryWithRelevance } from "../../src/types/memory.js";

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
});
