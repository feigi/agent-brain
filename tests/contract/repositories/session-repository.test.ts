import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";

describe.each(factories)("SessionRepository contract — $name", (factory) => {
  let backend: TestBackend;
  beforeEach(async () => {
    backend = await factory.create();
    // pg enforces workspace FK on sessions.
    await backend.workspaceRepo.findOrCreate("ws1");
  });
  afterEach(async () => {
    await backend.close();
  });

  it("createSession + findById round-trips", async () => {
    await backend.sessionRepo.createSession("s1", "u1", "p1", "ws1");
    const found = await backend.sessionRepo.findById("s1");
    expect(found).toMatchObject({
      id: "s1",
      user_id: "u1",
      project_id: "p1",
      workspace_id: "ws1",
      budget_used: 0,
    });
  });

  it("findById returns null for unknown id", async () => {
    expect(await backend.sessionRepo.findById("nope")).toBeNull();
  });

  it("getBudget returns null for unknown id", async () => {
    expect(await backend.sessionRepo.getBudget("nope")).toBeNull();
  });

  it("getBudget returns used + limit for created session", async () => {
    await backend.sessionRepo.createSession("s1", "u1", "p1", "ws1");
    const b = await backend.sessionRepo.getBudget("s1");
    expect(b?.used).toBe(0);
    expect(b?.limit).toBeGreaterThan(0);
  });

  it("incrementBudgetUsed advances used up to limit", async () => {
    await backend.sessionRepo.createSession("s1", "u1", "p1", "ws1");
    const r1 = await backend.sessionRepo.incrementBudgetUsed("s1", 2);
    expect(r1).toEqual({ used: 1, exceeded: false });
    const r2 = await backend.sessionRepo.incrementBudgetUsed("s1", 2);
    expect(r2).toEqual({ used: 2, exceeded: false });
  });

  it("incrementBudgetUsed returns exceeded once at limit", async () => {
    await backend.sessionRepo.createSession("s1", "u1", "p1", "ws1");
    await backend.sessionRepo.incrementBudgetUsed("s1", 1);
    const r = await backend.sessionRepo.incrementBudgetUsed("s1", 1);
    expect(r.exceeded).toBe(true);
    expect(r.used).toBe(1);
  });
});
