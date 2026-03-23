import { describe, it, expect } from "vitest";
import { slugSchema, contentSchema } from "../../src/utils/validation.js";

describe("slugSchema", () => {
  it("accepts valid slugs", () => {
    expect(slugSchema.safeParse("alice").success).toBe(true);
    expect(slugSchema.safeParse("my-project").success).toBe(true);
    expect(slugSchema.safeParse("project-123").success).toBe(true);
    expect(slugSchema.safeParse("a").success).toBe(true);
    expect(slugSchema.safeParse("a1b2c3").success).toBe(true);
  });

  it("rejects empty string", () => {
    const result = slugSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects uppercase letters", () => {
    const result = slugSchema.safeParse("Alice");
    expect(result.success).toBe(false);
  });

  it("rejects leading hyphens", () => {
    const result = slugSchema.safeParse("-project");
    expect(result.success).toBe(false);
  });

  it("rejects trailing hyphens", () => {
    const result = slugSchema.safeParse("project-");
    expect(result.success).toBe(false);
  });

  it("rejects consecutive hyphens", () => {
    const result = slugSchema.safeParse("my--project");
    expect(result.success).toBe(false);
  });

  it("rejects spaces", () => {
    const result = slugSchema.safeParse("my project");
    expect(result.success).toBe(false);
  });

  it("rejects special characters", () => {
    expect(slugSchema.safeParse("my_project").success).toBe(false);
    expect(slugSchema.safeParse("my.project").success).toBe(false);
    expect(slugSchema.safeParse("my@project").success).toBe(false);
  });

  it("rejects strings over 64 chars", () => {
    const long = "a".repeat(65);
    expect(slugSchema.safeParse(long).success).toBe(false);
  });

  it("accepts strings at exactly 64 chars", () => {
    const exact = "a".repeat(64);
    expect(slugSchema.safeParse(exact).success).toBe(true);
  });
});

describe("contentSchema", () => {
  it("accepts non-empty content", () => {
    expect(contentSchema.safeParse("hello world").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(contentSchema.safeParse("").success).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    expect(contentSchema.safeParse("   ").success).toBe(false);
    expect(contentSchema.safeParse("\n\t  ").success).toBe(false);
  });

  it("trims whitespace and accepts if content remains", () => {
    const result = contentSchema.safeParse("  hello  ");
    expect(result.success).toBe(true);
  });
});
