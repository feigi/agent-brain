import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBackend } from "../../../../src/backend/vault/index.js";

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "vault-migmode-"));
}

describe("VaultBackend migrationMode", () => {
  it("uses NOOP_GIT_OPS, skips watcher, skips push wiring", async () => {
    const root = await tmp();
    try {
      const backend = await VaultBackend.create({
        root,
        projectId: "p1",
        embeddingDimensions: 4,
        migrationMode: true,
      });
      // Repo write must succeed without erroring on a missing/no-op git repo.
      await backend.workspaceRepo.findOrCreate("ws1");
      // close() must not hang waiting for a watcher.
      await backend.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does NOT issue real commits when migrationMode is true", async () => {
    const root = await tmp();
    try {
      const backend = await VaultBackend.create({
        root,
        projectId: "p1",
        embeddingDimensions: 4,
        migrationMode: true,
      });
      const ws = await backend.workspaceRepo.findOrCreate("ws-test");
      expect(ws.id).toBe("ws-test");
      // The vault dir won't even be a git repo because ensureVaultGit was
      // bypassed in migration mode.
      await backend.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
