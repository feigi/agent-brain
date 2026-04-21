import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../../../../src/backend/vault/io/lock.js";

describe("vault lock", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-lock-"));
    await writeFile(join(root, "x.md"), "", "utf8");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes concurrent writers to the same file", async () => {
    const events: string[] = [];
    const p = join(root, "x.md");

    async function take(label: string) {
      await withFileLock(p, async () => {
        events.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, 30));
        events.push(`${label}:end`);
      });
    }

    await Promise.all([take("a"), take("b")]);

    // Each section runs atomically (no interleaving of start/end pairs).
    expect(events).toHaveLength(4);
    const startA = events.indexOf("a:start");
    const endA = events.indexOf("a:end");
    const startB = events.indexOf("b:start");
    const endB = events.indexOf("b:end");
    // Interleaving would look like a:start, b:start, a:end, b:end
    expect([endA < startB, endB < startA]).toContain(true);
  });

  it("releases lock on thrown error", async () => {
    const p = join(root, "x.md");
    await expect(
      withFileLock(p, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Second acquire must succeed, proving lock was released.
    let entered = false;
    await withFileLock(p, async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });

  it("returns the inner callback's value", async () => {
    const p = join(root, "x.md");
    const v = await withFileLock(p, async () => 42);
    expect(v).toBe(42);
  });
});
