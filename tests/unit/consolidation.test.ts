import { describe, it, expect } from "vitest";
import { classifyPair } from "../../src/services/consolidation-service.js";

describe("consolidation detection", () => {
  const thresholds = {
    autoArchiveThreshold: 0.95,
    flagThreshold: 0.9,
  };

  it("classifies near-exact duplicate as auto_archive", () => {
    const result = classifyPair(0.96, "same scope", false, thresholds);
    expect(result).toBe("auto_archive");
  });

  it("classifies probable duplicate as flag_duplicate", () => {
    const result = classifyPair(0.92, "same scope", false, thresholds);
    expect(result).toBe("flag_duplicate");
  });

  it("classifies cross-scope match as flag_superseded", () => {
    const result = classifyPair(0.92, "cross scope", false, thresholds);
    expect(result).toBe("flag_superseded");
  });

  it("returns null for low similarity", () => {
    const result = classifyPair(0.5, "same scope", false, thresholds);
    expect(result).toBeNull();
  });

  it("never auto-resolves user-scoped memories", () => {
    const result = classifyPair(0.97, "same scope", true, thresholds);
    expect(result).toBe("flag_duplicate");
  });

  it("returns null for medium similarity (below flag threshold)", () => {
    const result = classifyPair(0.85, "same scope", false, thresholds);
    expect(result).toBeNull();
  });

  it("returns null for medium similarity cross-scope (below flag threshold)", () => {
    const result = classifyPair(0.85, "cross scope", false, thresholds);
    expect(result).toBeNull();
  });

  it("returns null just below flag threshold", () => {
    const result = classifyPair(0.89, "same scope", false, thresholds);
    expect(result).toBeNull();
  });

  it("classifies at exactly flag threshold as flag_duplicate", () => {
    const result = classifyPair(0.9, "same scope", false, thresholds);
    expect(result).toBe("flag_duplicate");
  });

  it("classifies at exactly auto-archive threshold as auto_archive", () => {
    const result = classifyPair(0.95, "same scope", false, thresholds);
    expect(result).toBe("auto_archive");
  });
});
