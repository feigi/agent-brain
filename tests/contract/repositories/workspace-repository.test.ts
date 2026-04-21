import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";

describe.each(factories)("WorkspaceRepository contract — $name", (factory) => {
  let backend: TestBackend;
  beforeEach(async () => {
    backend = await factory.create();
  });
  afterEach(async () => {
    await backend.close();
  });

  it("findById returns null for unknown", async () => {
    expect(await backend.workspaceRepo.findById("never")).toBeNull();
  });

  it("findOrCreate is idempotent", async () => {
    const a = await backend.workspaceRepo.findOrCreate("alpha");
    const b = await backend.workspaceRepo.findOrCreate("alpha");
    expect(a.id).toBe("alpha");
    expect(a.created_at.toISOString()).toBe(b.created_at.toISOString());
  });

  it("findById returns created workspace", async () => {
    await backend.workspaceRepo.findOrCreate("beta");
    const got = await backend.workspaceRepo.findById("beta");
    expect(got?.id).toBe("beta");
  });
});
