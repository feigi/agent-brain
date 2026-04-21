import { describe, it, expect } from "vitest";
import * as arrow from "apache-arrow";
import { memorySchema } from "../../../../../src/backend/vault/vector/schema.js";

describe("memorySchema", () => {
  it("has the expected fields", () => {
    const s = memorySchema(768);
    const names = s.fields.map((f) => f.name).sort();
    expect(names).toEqual([
      "archived",
      "author",
      "content_hash",
      "id",
      "project_id",
      "scope",
      "title",
      "vector",
      "workspace_id",
    ]);
  });

  it("pins the vector dimension", () => {
    const s = memorySchema(4);
    const f = s.fields.find((x) => x.name === "vector")!;
    expect(f.type).toBeInstanceOf(arrow.FixedSizeList);
    expect((f.type as arrow.FixedSizeList).listSize).toBe(4);
  });
});
