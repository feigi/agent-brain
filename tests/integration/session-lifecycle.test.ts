import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestServiceWithSessions,
  truncateAll,
  closeDb,
} from "../helpers.js";
import { config } from "../../src/config.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("Session lifecycle and write budget integration tests", () => {
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    service = createTestServiceWithSessions();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("memory_session_start returns session_id in meta (AUTO-01)", async () => {
    const result = await service.sessionStart("test-project", "alice");

    expect(result.meta.session_id).toBeTypeOf("string");
    // nanoid generates 21-char IDs by default
    expect(result.meta.session_id!.length).toBe(21);
  });

  it("autonomous write with valid session_id succeeds and tracks budget (AUTO-03, AUTO-04)", async () => {
    // Step 1: Start session to get a valid session_id
    const sessionResult = await service.sessionStart("test-project", "alice");
    const sessionId = sessionResult.meta.session_id!;
    expect(sessionId).toBeTruthy();

    // Step 2: Write with agent-auto and the session_id
    const createResult = await service.create({
      workspace_id: "test-project",
      content:
        "Important database query optimization insight discovered during testing",
      type: "learning",
      author: "alice",
      source: "agent-auto",
      session_id: sessionId,
    });

    // Should succeed, not be skipped
    expect(createResult.data).toHaveProperty("id");
    expect("skipped" in createResult.data).toBe(false);

    // Budget meta should reflect used=1
    expect(createResult.meta.budget?.used).toBe(1);
  });

  it("session-review write counts toward budget", async () => {
    const sessionResult = await service.sessionStart("test-project", "alice");
    const sessionId = sessionResult.meta.session_id!;

    const createResult = await service.create({
      workspace_id: "test-project",
      content: "End-of-session review: found pattern in test file organization",
      type: "pattern",
      author: "alice",
      source: "session-review",
      session_id: sessionId,
    });

    expect(createResult.data).toHaveProperty("id");
    expect(createResult.meta.budget?.used).toBe(1);
  });

  it("budget enforcement after limit reached (AUTO-04)", async () => {
    const sessionResult = await service.sessionStart("test-project", "alice");
    const sessionId = sessionResult.meta.session_id!;
    const budgetLimit = config.writeBudgetPerSession; // 10

    // Write up to the budget limit using distinct content to avoid dedup
    for (let i = 0; i < budgetLimit; i++) {
      const result = await service.create({
        workspace_id: "test-project",
        content: `Unique insight number ${i} about ${i > 5 ? "testing" : "architecture"} discovered at step ${i} in the process of building the system ${Date.now() + i}`,
        type: "learning",
        author: "alice",
        source: "agent-auto",
        session_id: sessionId,
      });
      expect(result.data).toHaveProperty("id");
    }

    // The (budgetLimit + 1)th write should be soft-rejected
    const overBudgetResult = await service.create({
      workspace_id: "test-project",
      content: `This is the ${budgetLimit + 1}th write and should be rejected by the budget guard completely`,
      type: "fact",
      author: "alice",
      source: "agent-auto",
      session_id: sessionId,
    });

    expect(
      "skipped" in overBudgetResult.data && overBudgetResult.data.skipped,
    ).toBe(true);
    if ("skipped" in overBudgetResult.data) {
      expect(overBudgetResult.data.reason).toBe("budget_exceeded");
    }
    expect(overBudgetResult.meta.budget?.exceeded).toBe(true);
  });

  it("manual write does not count toward budget", async () => {
    const sessionResult = await service.sessionStart("test-project", "alice");
    const sessionId = sessionResult.meta.session_id!;

    // Do one autonomous write
    await service.create({
      workspace_id: "test-project",
      content:
        "First autonomous write to establish a budget baseline for this session test",
      type: "fact",
      author: "alice",
      source: "agent-auto",
      session_id: sessionId,
    });

    // Do a manual write (should not increment budget)
    await service.create({
      workspace_id: "test-project",
      content:
        "Manual write that should not consume budget -- explicitly set by user",
      type: "decision",
      author: "alice",
      source: "manual",
      session_id: sessionId,
    });

    // Do a second autonomous write -- budget should be 2 (not 3)
    const secondAutoResult = await service.create({
      workspace_id: "test-project",
      content:
        "Second autonomous write after manual write to verify budget tracking accuracy",
      type: "learning",
      author: "alice",
      source: "agent-auto",
      session_id: sessionId,
    });

    expect(secondAutoResult.data).toHaveProperty("id");
    // Budget should be 2 (first auto write + second auto write, manual not counted)
    expect(secondAutoResult.meta.budget?.used).toBe(2);
  });

  it("autonomous write without session_id succeeds without budget tracking (AUTO-03)", async () => {
    const autoResult = await service.create({
      workspace_id: "test-project",
      content: "agent-auto write without session_id",
      type: "fact",
      author: "alice",
      source: "agent-auto",
      // intentionally no session_id
    });

    expect(autoResult.data).toHaveProperty("id");
    expect(autoResult.meta.budget).toBeUndefined();

    const reviewResult = await service.create({
      workspace_id: "test-project",
      content: "session-review write without session_id",
      type: "fact",
      author: "alice",
      source: "session-review",
    });

    expect(reviewResult.data).toHaveProperty("id");
    expect(reviewResult.meta.budget).toBeUndefined();
  });

  it("different sessions have independent budgets", async () => {
    // Start two independent sessions
    const session1 = await service.sessionStart("test-project", "alice");
    const session2 = await service.sessionStart("test-project", "alice");
    const sessionId1 = session1.meta.session_id!;
    const sessionId2 = session2.meta.session_id!;

    expect(sessionId1).not.toBe(sessionId2);

    // Write to session 1
    await service.create({
      workspace_id: "test-project",
      content:
        "Session one autonomous write with unique content identifier abc123",
      type: "fact",
      author: "alice",
      source: "agent-auto",
      session_id: sessionId1,
    });

    // Write to session 2 -- should have its own budget counter starting at 0
    const result = await service.create({
      workspace_id: "test-project",
      content:
        "Session two autonomous write with unique content identifier def456",
      type: "fact",
      author: "alice",
      source: "agent-auto",
      session_id: sessionId2,
    });

    // Session 2 budget should be 1, not 2
    expect(result.meta.budget?.used).toBe(1);
  });
});
