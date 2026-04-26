import { describe, it, expect } from "vitest";
import {
  checkDims,
  checkTargetEmpty,
  checkDrizzleCurrent,
} from "../../../../src/cli/migrate/preflight.js";

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

describe("preflight.checkTargetEmpty", () => {
  it("ok when count is 0", async () => {
    const res = await checkTargetEmpty({ countMemories: async () => 0 });
    expect(res.ok).toBe(true);
  });

  it("fails when count > 0 with TRUNCATE remediation hint", async () => {
    const res = await checkTargetEmpty({ countMemories: async () => 42 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/not empty/i);
      expect(res.reason).toMatch(/TRUNCATE/);
      expect(res.reason).toMatch(/42/);
    }
  });

  it("propagates underlying connection error", async () => {
    await expect(
      checkTargetEmpty({
        countMemories: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("preflight.checkDrizzleCurrent", () => {
  it("ok when latest applied hash matches expected", async () => {
    const res = await checkDrizzleCurrent({
      latestApplied: async () => "deadbeef",
      expectedHash: "deadbeef",
    });
    expect(res.ok).toBe(true);
  });

  it("fails with db:migrate hint when stale", async () => {
    const res = await checkDrizzleCurrent({
      latestApplied: async () => "old",
      expectedHash: "new",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/stale|out of date/i);
      expect(res.reason).toMatch(/db:migrate/);
    }
  });

  it("fails when no migrations have been applied yet", async () => {
    const res = await checkDrizzleCurrent({
      latestApplied: async () => null,
      expectedHash: "any",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/no migrations/i);
    }
  });
});
