import { describe, it, expect } from "vitest";
import { z } from "zod";
import { memoryScopeEnum, memoryTypeEnum } from "../../src/utils/validation.js";

// Regression tests for MCP tool schema validation.
// Previously used .catch(fallback) which silently coerced any invalid value to the
// fallback — an agent passing scope: ["frobnicate"] would silently get workspace results.
// Fixed to use .default(fallback) which only fires on undefined and lets invalid values throw.

describe("MCP tool schema .default() vs .catch() behaviour", () => {
  const scopeSchema = z.array(memoryScopeEnum).min(1).default(["workspace"]);

  it("applies default when scope is undefined", () => {
    expect(scopeSchema.parse(undefined)).toEqual(["workspace"]);
  });

  it("rejects invalid scope values instead of silently coercing", () => {
    expect(() => scopeSchema.parse(["frobnicate"])).toThrow();
  });

  it("accepts valid scope values", () => {
    expect(scopeSchema.parse(["workspace", "user"])).toEqual([
      "workspace",
      "user",
    ]);
  });

  const typeSchema = memoryTypeEnum.optional();

  it("passes through undefined type without coercion", () => {
    expect(typeSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects invalid type values", () => {
    expect(() => typeSchema.parse("invalid-type")).toThrow();
  });

  const sortSchema = z.enum(["created_at", "updated_at"]).default("created_at");

  it("applies default when sort_by is undefined", () => {
    expect(sortSchema.parse(undefined)).toBe("created_at");
  });

  it("rejects invalid sort_by values instead of silently coercing", () => {
    expect(() => sortSchema.parse("bad-field")).toThrow();
  });
});
