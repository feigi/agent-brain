import { describe, it, expect } from "vitest";
import { checkDims } from "../../../../src/cli/migrate/preflight.js";

describe("preflight.checkDims", () => {
  it("ok when source and destination dims match", () => {
    const res = checkDims({ sourceDim: 768, destDim: 768, reembed: false });
    expect(res.ok).toBe(true);
  });

  it("fails when dims mismatch and reembed is false", () => {
    const res = checkDims({ sourceDim: 768, destDim: 1024, reembed: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/dim mismatch/i);
      expect(res.reason).toMatch(/--reembed/);
    }
  });

  it("ok when dims mismatch but reembed is true (vectors regenerated)", () => {
    const res = checkDims({ sourceDim: 768, destDim: 1024, reembed: true });
    expect(res.ok).toBe(true);
  });
});
