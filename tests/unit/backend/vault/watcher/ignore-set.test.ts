// tests/unit/backend/vault/watcher/ignore-set.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  IgnoreSetImpl,
  NoopIgnoreSet,
} from "../../../../../src/backend/vault/watcher/ignore-set.js";

describe("IgnoreSetImpl", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns false for an unknown path", () => {
    const s = new IgnoreSetImpl();
    expect(s.has("/abs/foo.md", 1234567890)).toBe(false);
  });

  it("returns true when path tracked and mtime matches", () => {
    const s = new IgnoreSetImpl();
    s.add("/abs/foo.md", 100);
    expect(s.has("/abs/foo.md", 100)).toBe(true);
  });

  it("returns false when path tracked but mtime differs (external edit collided)", () => {
    const s = new IgnoreSetImpl();
    s.add("/abs/foo.md", 100);
    expect(s.has("/abs/foo.md", 200)).toBe(false);
  });

  it("releaseAfter clears the entry after the grace window", () => {
    const s = new IgnoreSetImpl();
    s.add("/abs/foo.md", 100);
    s.releaseAfter("/abs/foo.md", 500);
    expect(s.has("/abs/foo.md", 100)).toBe(true);
    vi.advanceTimersByTime(499);
    expect(s.has("/abs/foo.md", 100)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.has("/abs/foo.md", 100)).toBe(false);
  });

  it("releaseAfter is a no-op for an untracked path", () => {
    const s = new IgnoreSetImpl();
    expect(() => s.releaseAfter("/abs/missing.md", 500)).not.toThrow();
    vi.advanceTimersByTime(500);
    expect(s.has("/abs/missing.md", 1)).toBe(false);
  });

  it("re-add before grace expiry refreshes mtime + cancels prior release", () => {
    const s = new IgnoreSetImpl();
    s.add("/abs/foo.md", 100);
    s.releaseAfter("/abs/foo.md", 500);
    vi.advanceTimersByTime(300);
    s.add("/abs/foo.md", 200);
    s.releaseAfter("/abs/foo.md", 500);
    vi.advanceTimersByTime(400);
    expect(s.has("/abs/foo.md", 200)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(s.has("/abs/foo.md", 200)).toBe(false);
  });
});

describe("NoopIgnoreSet", () => {
  it("never tracks anything", () => {
    const s = new NoopIgnoreSet();
    s.add("/abs/foo.md", 100);
    expect(s.has("/abs/foo.md", 100)).toBe(false);
    s.releaseAfter("/abs/foo.md", 500);
    expect(s.has("/abs/foo.md", 100)).toBe(false);
  });
});
