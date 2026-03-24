import { describe, it, expect } from "vitest";
import {
  exponentialDecay,
  computeRelevance,
  SIMILARITY_WEIGHT,
  RECENCY_WEIGHT,
  VERIFICATION_BOOST,
  OVER_FETCH_FACTOR,
} from "../../src/utils/scoring.js";

const NOW = new Date("2026-03-23T00:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("exponentialDecay", () => {
  it("returns 1.0 for age=0 (brand new memory)", () => {
    expect(exponentialDecay(0, 14)).toBe(1.0);
  });

  it("returns 0.5 for age=halfLife (one half-life elapsed)", () => {
    expect(exponentialDecay(14, 14)).toBeCloseTo(0.5, 10);
  });

  it("returns 0.25 for age=2*halfLife (two half-lives elapsed)", () => {
    expect(exponentialDecay(28, 14)).toBeCloseTo(0.25, 10);
  });

  it("returns 1.0 for negative age (clamped to 0)", () => {
    expect(exponentialDecay(-1, 14)).toBe(1.0);
  });

  it("approaches 0 for very large ages", () => {
    const result = exponentialDecay(1000, 14);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.001);
  });
});

describe("computeRelevance", () => {
  it("returns ~0.95 for perfect similarity, brand new, not verified", () => {
    // 0.80 * 1.0 + 0.15 * 1.0 + 0 = 0.95
    const result = computeRelevance(1.0, NOW, null, 14, NOW);
    expect(result).toBeCloseTo(0.95, 5);
  });

  it("returns 1.0 for perfect similarity, brand new, verified", () => {
    // 0.80 * 1.0 + 0.15 * 1.0 + 0.05 = 1.0
    const result = computeRelevance(1.0, NOW, NOW, 14, NOW);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it("returns ~0.475 for medium similarity, one half-life old, not verified", () => {
    // 0.80 * 0.5 + 0.15 * 0.5 + 0 = 0.40 + 0.075 = 0.475
    const createdAt = daysAgo(14);
    const result = computeRelevance(0.5, createdAt, null, 14, NOW);
    expect(result).toBeCloseTo(0.475, 5);
  });

  it("returns ~0.80 for perfect similarity, very old memory, not verified", () => {
    // 0.80 * 1.0 + 0.15 * ~0 + 0 = ~0.80 (similarity dominates)
    const createdAt = daysAgo(1000);
    const result = computeRelevance(1.0, createdAt, null, 14, NOW);
    expect(result).toBeCloseTo(0.8, 2);
  });

  it("clamps result to [0, 1] range", () => {
    // Even with max inputs, result should not exceed 1
    const result = computeRelevance(1.5, NOW, NOW, 14, NOW);
    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("handles zero similarity correctly", () => {
    // 0.80 * 0 + 0.15 * 1.0 + 0 = 0.15
    const result = computeRelevance(0, NOW, null, 14, NOW);
    expect(result).toBeCloseTo(0.15, 5);
  });

  it("adds verification boost when verifiedAt is provided", () => {
    const withoutVerified = computeRelevance(0.7, daysAgo(7), null, 14, NOW);
    const withVerified = computeRelevance(0.7, daysAgo(7), daysAgo(1), 14, NOW);
    expect(withVerified - withoutVerified).toBeCloseTo(VERIFICATION_BOOST, 5);
  });

  it("uses current time when now is not provided", () => {
    // Just verify it doesn't throw and returns a valid number
    const result = computeRelevance(0.8, new Date(), null, 14);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe("constants", () => {
  it("exports correct weight values", () => {
    expect(SIMILARITY_WEIGHT).toBe(0.8);
    expect(RECENCY_WEIGHT).toBe(0.15);
    expect(VERIFICATION_BOOST).toBe(0.05);
  });

  it("exports OVER_FETCH_FACTOR as 3", () => {
    expect(OVER_FETCH_FACTOR).toBe(3);
  });
});
