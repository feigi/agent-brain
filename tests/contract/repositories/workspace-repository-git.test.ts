import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vaultGitFactory, type TestBackend } from "./_factories.js";
import { commitCount, lastCommitMessage } from "./_git-helpers.js";

describe("WorkspaceRepository git commits — vault", () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await vaultGitFactory.create();
  });

  afterAll(async () => {
    await backend.close();
  });

  it("findOrCreate produces one commit with AB-Action: workspace_upsert on first call", async () => {
    const root = backend.gitRoot!;
    const before = await commitCount(root);
    await backend.workspaceRepo.findOrCreate("ws-new");
    const after = await commitCount(root);
    expect(after - before).toBe(1);
    const msg = await lastCommitMessage(root);
    expect(msg).toContain("AB-Action: workspace_upsert");
    expect(msg).toContain("AB-Workspace: ws-new");
  });

  it("findOrCreate is idempotent: second call produces no new commit", async () => {
    const root = backend.gitRoot!;
    await backend.workspaceRepo.findOrCreate("ws-idempotent");
    const after1 = await commitCount(root);
    await backend.workspaceRepo.findOrCreate("ws-idempotent");
    const after2 = await commitCount(root);
    expect(after2).toBe(after1);
  });
});
