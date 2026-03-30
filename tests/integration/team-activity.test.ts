import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestService,
  truncateAll,
  closeDb,
  assertMemory,
} from "../helpers.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("Team Activity", () => {
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  // --- D-28, D-29: session tracking and team_activity ---
  describe("session tracking", () => {
    it("session_start includes team_activity in meta (D-29)", async () => {
      // Create some memories before session
      await service.create({
        project_id: "test-project",
        content: "Recent note",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });

      const result = await service.sessionStart("test-project", "bob");
      expect(result.meta.team_activity).toBeDefined();
      expect(result.meta.team_activity!.since).toBeDefined();
      expect(typeof result.meta.team_activity!.new_memories).toBe("number");
      expect(typeof result.meta.team_activity!.updated_memories).toBe("number");
      expect(typeof result.meta.team_activity!.commented_memories).toBe(
        "number",
      );
      expect(
        result.meta.team_activity!.commented_memories,
      ).toBeGreaterThanOrEqual(0);
    });

    it("team_activity.commented_memories counts commented memories since last session", async () => {
      // First session to establish baseline
      await service.sessionStart("test-project", "alice");

      // Create a memory authored by alice
      const { data: memory } = await service.create({
        project_id: "test-project",
        content: "A note for discussion",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);

      // Bob comments on alice's memory (self-comment is blocked, so use different user)
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.addComment(memory.id, "bob", "Great insight");

      // Second session -- commented_memories should reflect the comment
      const result = await service.sessionStart("test-project", "alice");
      expect(
        result.meta.team_activity!.commented_memories,
      ).toBeGreaterThanOrEqual(1);
    });

    it("team_activity counts new memories since last session", async () => {
      // First session to establish baseline
      await service.sessionStart("test-project", "alice");

      // Create a memory after first session
      await service.create({
        project_id: "test-project",
        content: "New note",
        type: "fact",
        author: "bob",
        scope: "workspace",
      });

      // Second session should show the new memory
      const result = await service.sessionStart("test-project", "alice");
      expect(result.meta.team_activity!.new_memories).toBeGreaterThanOrEqual(1);
    });

    it("D-30: team_activity includes user's own changes", async () => {
      await service.sessionStart("test-project", "alice");

      await service.create({
        project_id: "test-project",
        content: "My own note",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });

      const result = await service.sessionStart("test-project", "alice");
      expect(result.meta.team_activity!.new_memories).toBeGreaterThanOrEqual(1);
    });

    it("D-31: first session falls back to 7 days", async () => {
      // First session ever -- should use 7-day fallback
      const result = await service.sessionStart("test-project", "alice");
      expect(result.meta.team_activity).toBeDefined();
      // The 'since' timestamp should be approximately 7 days ago
      const since = new Date(result.meta.team_activity!.since);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      // Allow 10 second tolerance
      expect(Math.abs(since.getTime() - sevenDaysAgo.getTime())).toBeLessThan(
        10_000,
      );
    });
  });

  // --- D-33 through D-40: memory_list_recent ---
  describe("list_recent", () => {
    it("returns memories created after 'since' timestamp", async () => {
      const sinceDate = new Date();

      await service.create({
        project_id: "test-project",
        content: "New note",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });

      const result = await service.listRecentActivity(
        "test-project",
        "bob",
        sinceDate,
        10,
        false,
      );
      expect(result.data.length).toBeGreaterThanOrEqual(1);
      expect(result.data[0].change_type).toBe("created");
    });

    it("returns memories with change_type 'updated' for content changes", async () => {
      const { data: memory } = await service.create({
        project_id: "test-project",
        content: "Original",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);

      const sinceDate = new Date();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.update(
        memory.id,
        memory.version,
        { content: "Updated" },
        "bob",
      );

      const result = await service.listRecentActivity(
        "test-project",
        "bob",
        sinceDate,
        10,
        false,
      );
      const updatedMemory = result.data.find((m) => m.id === memory.id);
      expect(updatedMemory).toBeDefined();
      expect(updatedMemory!.change_type).toBe("updated");
    });

    it("returns memories with change_type 'commented' (D-37)", async () => {
      const { data: memory } = await service.create({
        project_id: "test-project",
        content: "Note",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);

      const sinceDate = new Date();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.addComment(memory.id, "bob", "A comment");

      const result = await service.listRecentActivity(
        "test-project",
        "charlie",
        sinceDate,
        10,
        false,
      );
      const commentedMemory = result.data.find((m) => m.id === memory.id);
      expect(commentedMemory).toBeDefined();
      expect(commentedMemory!.change_type).toBe("commented");
    });

    it("exclude_self filters out requesting user's memories (D-38)", async () => {
      const sinceDate = new Date();

      await service.create({
        project_id: "test-project",
        content: "Alice's note",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      await service.create({
        project_id: "test-project",
        content: "Bob's note",
        type: "fact",
        author: "bob",
        scope: "workspace",
      });

      const result = await service.listRecentActivity(
        "test-project",
        "alice",
        sinceDate,
        10,
        true, // exclude_self
      );
      // Should only see Bob's note
      for (const m of result.data) {
        expect(m.author).not.toBe("alice");
      }
    });

    it("respects scope privacy -- hides other users' private memories", async () => {
      const sinceDate = new Date();

      await service.create({
        project_id: "test-project",
        content: "Alice private",
        type: "fact",
        author: "alice",
        scope: "user",
      });

      const result = await service.listRecentActivity(
        "test-project",
        "bob",
        sinceDate,
        10,
        false,
      );
      // Bob should not see Alice's user-scoped memory
      const alicePrivate = result.data.find(
        (m) => m.content === "Alice private",
      );
      expect(alicePrivate).toBeUndefined();
    });

    it("D-39: respects limit parameter", async () => {
      const sinceDate = new Date();

      for (let i = 0; i < 5; i++) {
        await service.create({
          project_id: "test-project",
          content: `Note ${i}`,
          type: "fact",
          author: "alice",
          scope: "workspace",
        });
      }

      const result = await service.listRecentActivity(
        "test-project",
        "bob",
        sinceDate,
        2,
        false,
      );
      expect(result.data.length).toBeLessThanOrEqual(2);
    });
  });
});
