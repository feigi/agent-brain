import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultWorkspaceRepository } from "../../../../../src/backend/vault/repositories/workspace-repository.js";

describe("VaultWorkspaceRepository", () => {
  let root: string;
  let repo: VaultWorkspaceRepository;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-ws-"));
    repo = new VaultWorkspaceRepository({ root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("findById returns null for unknown slug", async () => {
    expect(await repo.findById("agent-brain")).toBeNull();
  });

  it("findOrCreate creates workspaces/<slug>/_workspace.md", async () => {
    const first = await repo.findOrCreate("agent-brain");
    expect(first.id).toBe("agent-brain");
    expect(first.created_at).toBeInstanceOf(Date);

    const raw = await readFile(
      join(root, "workspaces/agent-brain/_workspace.md"),
      "utf8",
    );
    expect(raw).toMatch(/id: agent-brain/);
    expect(raw).toMatch(/created:/);
  });

  it("findOrCreate is idempotent — same slug returns same created_at", async () => {
    const a = await repo.findOrCreate("ab");
    const b = await repo.findOrCreate("ab");
    expect(a.created_at.toISOString()).toBe(b.created_at.toISOString());
  });

  it("findById returns metadata after create", async () => {
    const created = await repo.findOrCreate("ws1");
    const found = await repo.findById("ws1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("ws1");
    expect(found!.created_at.toISOString()).toBe(
      created.created_at.toISOString(),
    );
  });

  it("concurrent findOrCreate calls converge on one created_at", async () => {
    const [a, b] = await Promise.all([
      repo.findOrCreate("race"),
      repo.findOrCreate("race"),
    ]);
    expect(a.created_at.toISOString()).toBe(b.created_at.toISOString());
  });
});
