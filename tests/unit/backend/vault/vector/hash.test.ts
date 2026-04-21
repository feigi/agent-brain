import { describe, it, expect } from "vitest";
import { contentHash } from "../../../../../src/backend/vault/vector/hash.js";

describe("contentHash", () => {
  it("is deterministic for equal content", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("differs for different content", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });

  it("is a 64-char hex string (sha256)", () => {
    expect(contentHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
