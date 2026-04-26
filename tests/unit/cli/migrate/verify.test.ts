import { describe, it, expect } from "vitest";
import { compareCounts } from "../../../../src/cli/migrate/verify.js";
import type { CountsByKind } from "../../../../src/cli/migrate/types.js";

const sample: CountsByKind = {
  workspaces: 3,
  memories: 100,
  comments: 50,
  flags: 7,
  relationships: 20,
};

describe("verify.compareCounts", () => {
  it("returns empty diff when source and destination match", () => {
    const diff = compareCounts(sample, { ...sample });
    expect(diff).toEqual([]);
  });

  it("flags every mismatched kind", () => {
    const dest: CountsByKind = { ...sample, memories: 99, flags: 6 };
    const diff = compareCounts(sample, dest);
    expect(diff).toEqual([
      { kind: "memories", source: 100, destination: 99 },
      { kind: "flags", source: 7, destination: 6 },
    ]);
  });

  it("preserves canonical kind order in the diff list", () => {
    const dest: CountsByKind = {
      workspaces: 0,
      memories: 0,
      comments: 0,
      flags: 0,
      relationships: 0,
    };
    const diff = compareCounts(sample, dest);
    expect(diff.map((d) => d.kind)).toEqual([
      "workspaces",
      "memories",
      "comments",
      "flags",
      "relationships",
    ]);
  });
});
