import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createTestService,
  truncateAll,
  closeDb,
  assertMemory,
} from "../helpers.js";
import { NotFoundError } from "../../src/utils/errors.js";
import type { MemoryService } from "../../src/services/memory-service.js";

describe("Access Control", () => {
  let service: MemoryService;

  beforeEach(async () => {
    await truncateAll();
    service = createTestService();
  });

  afterAll(async () => {
    await closeDb();
  });

  // --- TEAM-01: shared project memories ---
  describe("shared project memories", () => {
    it("two users can both write and read project memories", async () => {
      // Alice creates a project memory
      const alice = await service.create({
        workspace_id: "test-project",
        content: "Alice's note",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(alice.data);

      // Bob creates a project memory
      const bob = await service.create({
        workspace_id: "test-project",
        content: "Bob's note",
        type: "fact",
        author: "bob",
        scope: "workspace",
      });
      assertMemory(bob.data);

      // Bob can read Alice's memory
      const readByBob = await service.get(alice.data.id, "bob");
      expect(readByBob.data.content).toBe("Alice's note");

      // Alice can read Bob's memory
      const readByAlice = await service.get(bob.data.id, "alice");
      expect(readByAlice.data.content).toBe("Bob's note");
    });

    it("any user can update a project memory", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Original",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);
      // Bob updates Alice's project memory
      const updated = await service.update(
        memory.id,
        memory.version,
        { content: "Updated by Bob" },
        "bob",
      );
      expect(updated.data.content).toBe("Updated by Bob");
    });

    it("any user can archive a project memory", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "To archive",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);
      const result = await service.archive(memory.id, "bob");
      expect(result.data.archived_count).toBe(1);
    });
  });

  // --- D-11: user-scoped memory privacy ---
  describe("user scope privacy", () => {
    it("owner can read their own user-scoped memory", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Private note",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      assertMemory(memory);
      const result = await service.get(memory.id, "alice");
      expect(result.data.content).toBe("Private note");
    });

    it("non-owner gets 'not found' for user-scoped memory (D-17)", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Alice private",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      assertMemory(memory);
      await expect(service.get(memory.id, "bob")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("non-owner cannot update user-scoped memory", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Private",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      assertMemory(memory);
      await expect(
        service.update(memory.id, memory.version, { content: "Hacked" }, "bob"),
      ).rejects.toThrow(); // AuthorizationError or NotFoundError
    });

    it("non-owner cannot archive user-scoped memory (D-15)", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Private",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      assertMemory(memory);
      await expect(service.archive(memory.id, "bob")).rejects.toThrow();
    });
  });

  // --- TEAM-02: author tracking ---
  describe("author tracking", () => {
    it("memory records the author who created it", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Note",
        type: "fact",
        author: "alice",
      });
      assertMemory(memory);
      expect(memory.author).toBe("alice");
    });
  });

  // --- TEAM-03: provenance ---
  describe("provenance", () => {
    it("comment records the commenter as author", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Original",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);
      const { data: comment } = await service.addComment(
        memory.id,
        "bob",
        "My comment",
      );
      expect(comment.author).toBe("bob");
    });
  });

  // --- TEAM-06: verify with verified_by ---
  describe("verify", () => {
    it("verify sets verified_at and verified_by (D-19)", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Fact to verify",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);
      const verified = await service.verify(memory.id, "bob");
      expect(verified.data.verified_at).toBeDefined();
      expect(verified.data.verified_by).toBe("bob");
    });

    it("non-owner cannot verify user-scoped memory (D-20)", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Private fact",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      assertMemory(memory);
      await expect(service.verify(memory.id, "bob")).rejects.toThrow();
    });

    it("owner can verify their own user-scoped memory", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "My fact",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      assertMemory(memory);
      const verified = await service.verify(memory.id, "alice");
      expect(verified.data.verified_by).toBe("alice");
    });
  });

  // --- TEAM-07: stale list with scope enforcement ---
  describe("stale memories with scope enforcement", () => {
    it("list_stale returns project memories for any user", async () => {
      await service.create({
        workspace_id: "test-project",
        content: "Old fact",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      const result = await service.listStale("test-project", "bob", 0);
      expect(result.data.length).toBeGreaterThanOrEqual(1);
    });

    it("list_stale filters out other users' user-scoped memories (D-16)", async () => {
      await service.create({
        workspace_id: "test-project",
        content: "Alice private",
        type: "fact",
        author: "alice",
        scope: "user",
      });
      await service.create({
        workspace_id: "test-project",
        content: "Bob private",
        type: "fact",
        author: "bob",
        scope: "user",
      });
      // Bob should only see Bob's user-scoped stale memories, not Alice's
      const result = await service.listStale("test-project", "bob", 0);
      const userScoped = result.data.filter((m) => m.scope === "user");
      for (const m of userScoped) {
        expect(m.author).toBe("bob");
      }
    });
  });

  // --- comment_count on all responses ---
  describe("comment_count field", () => {
    it("newly created memory has comment_count 0", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Note",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);
      expect(memory.comment_count).toBe(0);
    });

    it("memory has correct comment_count after comments added", async () => {
      const { data: memory } = await service.create({
        workspace_id: "test-project",
        content: "Note",
        type: "fact",
        author: "alice",
        scope: "workspace",
      });
      assertMemory(memory);
      await service.addComment(memory.id, "bob", "Comment 1");
      await service.addComment(memory.id, "charlie", "Comment 2");

      const fetched = await service.get(memory.id, "alice");
      expect(fetched.data.comment_count).toBe(2);
    });
  });
});
