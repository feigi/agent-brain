import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend } from "../../../src/backend/factory.js";

describe("createBackend", () => {
  it("constructs a vault backend rooted at vaultRoot", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-vault-"));
    try {
      const backend = await createBackend({
        backend: "vault",
        databaseUrl: "postgresql://unused",
        vaultRoot: root,
      });
      expect(backend.name).toBe("vault");
      await backend.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects the vault backend when vaultRoot is empty", async () => {
    await expect(
      createBackend({
        backend: "vault",
        databaseUrl: "postgresql://unused",
        vaultRoot: "",
      }),
    ).rejects.toThrow(/AGENT_BRAIN_VAULT_ROOT/);
  });

  it("throws when given an unknown backend name", async () => {
    await expect(
      createBackend({
        // @ts-expect-error — intentionally exercising a runtime-only bad value
        backend: "nosuch",
        databaseUrl: "postgresql://unused",
        vaultRoot: "",
      }),
    ).rejects.toThrow(/unknown backend/i);
  });
});
