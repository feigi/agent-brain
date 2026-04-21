import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";
import type { Memory } from "../../../src/types/memory.js";
import type { Relationship } from "../../../src/types/relationship.js";

const ZERO_EMB = new Array(768).fill(0);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date("2026-04-21T00:00:00.000Z");
  return {
    id: "m1",
    project_id: "p1",
    workspace_id: "ws1",
    content: "body",
    title: "T",
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "chris",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: null,
    embedding_dimensions: null,
    version: 1,
    created_at: now,
    updated_at: now,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
    ...overrides,
  };
}

function makeRel(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: "r1",
    project_id: "p1",
    source_id: "m1",
    target_id: "m2",
    type: "overrides",
    description: null,
    confidence: 0.95,
    created_by: "chris",
    created_via: null,
    archived_at: null,
    created_at: new Date("2026-04-21T10:00:00.000Z"),
    ...overrides,
  };
}

describe.each(factories)(
  "RelationshipRepository contract — $name",
  (factory) => {
    let backend: TestBackend;
    beforeEach(async () => {
      backend = await factory.create();
      await backend.workspaceRepo.findOrCreate("ws1");
      // Two memories in same workspace so FK + cross-memory lookup works.
      await backend.memoryRepo.create({
        ...makeMemory({ id: "m1" }),
        embedding: ZERO_EMB,
      });
      await backend.memoryRepo.create({
        ...makeMemory({ id: "m2" }),
        embedding: ZERO_EMB,
      });
    });
    afterEach(async () => {
      await backend.close();
    });

    it("create + findById round-trips", async () => {
      await backend.relationshipRepo.create(makeRel());
      const found = await backend.relationshipRepo.findById("r1");
      expect(found).not.toBeNull();
      expect(found).toMatchObject({
        id: "r1",
        source_id: "m1",
        target_id: "m2",
        type: "overrides",
        created_by: "chris",
      });
      expect(found!.confidence).toBeCloseTo(0.95, 4);
    });

    it("findById returns null for unknown id", async () => {
      expect(await backend.relationshipRepo.findById("nope")).toBeNull();
    });

    it("findByMemoryId outgoing returns rels with source=id", async () => {
      await backend.relationshipRepo.create(makeRel());
      const rels = await backend.relationshipRepo.findByMemoryId(
        "p1",
        "m1",
        "outgoing",
      );
      expect(rels.map((r) => r.id)).toEqual(["r1"]);
    });

    it("findByMemoryId incoming returns rels with target=id", async () => {
      await backend.relationshipRepo.create(makeRel());
      const rels = await backend.relationshipRepo.findByMemoryId(
        "p1",
        "m2",
        "incoming",
      );
      expect(rels.map((r) => r.id)).toEqual(["r1"]);
    });

    it("findByMemoryId both returns outgoing + incoming", async () => {
      await backend.relationshipRepo.create(
        makeRel({ id: "r1", source_id: "m1", target_id: "m2" }),
      );
      await backend.relationshipRepo.create(
        makeRel({ id: "r2", source_id: "m2", target_id: "m1" }),
      );
      const rels = await backend.relationshipRepo.findByMemoryId(
        "p1",
        "m1",
        "both",
      );
      expect(rels.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    });

    it("findByMemoryId filters by type when provided", async () => {
      await backend.relationshipRepo.create(
        makeRel({ id: "r1", type: "overrides" }),
      );
      await backend.relationshipRepo.create(
        makeRel({ id: "r2", type: "refines" }),
      );
      const overrides = await backend.relationshipRepo.findByMemoryId(
        "p1",
        "m1",
        "outgoing",
        "overrides",
      );
      expect(overrides.map((r) => r.id)).toEqual(["r1"]);
    });

    it("findExisting returns the one matching relationship", async () => {
      await backend.relationshipRepo.create(
        makeRel({ id: "r1", type: "overrides" }),
      );
      const hit = await backend.relationshipRepo.findExisting(
        "p1",
        "m1",
        "m2",
        "overrides",
      );
      expect(hit?.id).toBe("r1");
      expect(
        await backend.relationshipRepo.findExisting(
          "p1",
          "m1",
          "m2",
          "refines",
        ),
      ).toBeNull();
    });

    it("findBetweenMemories returns rels where both endpoints are in the set", async () => {
      await backend.memoryRepo.create({
        ...makeMemory({ id: "m3" }),
        embedding: ZERO_EMB,
      });
      await backend.relationshipRepo.create(
        makeRel({ id: "r1", source_id: "m1", target_id: "m2" }),
      );
      await backend.relationshipRepo.create(
        makeRel({ id: "r2", source_id: "m2", target_id: "m3" }),
      );
      // This one has an endpoint outside the queried set.
      await backend.memoryRepo.create({
        ...makeMemory({ id: "m4" }),
        embedding: ZERO_EMB,
      });
      await backend.relationshipRepo.create(
        makeRel({ id: "r3", source_id: "m1", target_id: "m4" }),
      );

      const between = await backend.relationshipRepo.findBetweenMemories("p1", [
        "m1",
        "m2",
        "m3",
      ]);
      expect(between.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    });

    it("findBetweenMemories returns [] for fewer than 2 ids", async () => {
      expect(
        await backend.relationshipRepo.findBetweenMemories("p1", []),
      ).toEqual([]);
      expect(
        await backend.relationshipRepo.findBetweenMemories("p1", ["m1"]),
      ).toEqual([]);
    });

    it("archiveByMemoryId archives both incoming + outgoing relationships", async () => {
      await backend.memoryRepo.create({
        ...makeMemory({ id: "m3" }),
        embedding: ZERO_EMB,
      });
      await backend.relationshipRepo.create(
        makeRel({ id: "r-out", source_id: "m1", target_id: "m2" }),
      );
      await backend.relationshipRepo.create(
        makeRel({ id: "r-in", source_id: "m3", target_id: "m1" }),
      );
      const count = await backend.relationshipRepo.archiveByMemoryId(
        "m1",
        "p1",
      );
      expect(count).toBe(2);
      expect(await backend.relationshipRepo.findById("r-out")).toBeNull();
      expect(await backend.relationshipRepo.findById("r-in")).toBeNull();
    });

    it("archiveByMemoryId scoped to projectId", async () => {
      await backend.relationshipRepo.create(makeRel({ id: "r1" }));
      const count = await backend.relationshipRepo.archiveByMemoryId(
        "m1",
        "other-project",
      );
      expect(count).toBe(0);
      expect(await backend.relationshipRepo.findById("r1")).not.toBeNull();
    });

    it("archiveById returns true on first archive, false after", async () => {
      await backend.relationshipRepo.create(makeRel());
      expect(await backend.relationshipRepo.archiveById("r1")).toBe(true);
      expect(await backend.relationshipRepo.archiveById("r1")).toBe(false);
      expect(await backend.relationshipRepo.findById("r1")).toBeNull();
    });

    it("archiveById returns false for unknown id", async () => {
      expect(await backend.relationshipRepo.archiveById("nope")).toBe(false);
    });

    it("findByMemoryIds collects across direction", async () => {
      await backend.memoryRepo.create({
        ...makeMemory({ id: "m3" }),
        embedding: ZERO_EMB,
      });
      await backend.relationshipRepo.create(
        makeRel({ id: "r1", source_id: "m1", target_id: "m2" }),
      );
      await backend.relationshipRepo.create(
        makeRel({ id: "r2", source_id: "m3", target_id: "m1" }),
      );
      const both = await backend.relationshipRepo.findByMemoryIds(
        "p1",
        ["m1"],
        "both",
      );
      expect(both.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
      const outgoing = await backend.relationshipRepo.findByMemoryIds(
        "p1",
        ["m1"],
        "outgoing",
      );
      expect(outgoing.map((r) => r.id)).toEqual(["r1"]);
      const incoming = await backend.relationshipRepo.findByMemoryIds(
        "p1",
        ["m1"],
        "incoming",
      );
      expect(incoming.map((r) => r.id)).toEqual(["r2"]);
    });

    it("findByMemoryIds returns [] for empty input", async () => {
      expect(
        await backend.relationshipRepo.findByMemoryIds("p1", [], "both"),
      ).toEqual([]);
    });

    it("description round-trips with quotes and backslashes", async () => {
      const description = 'because "X" implies \\backslash';
      await backend.relationshipRepo.create(makeRel({ description }));
      const found = await backend.relationshipRepo.findById("r1");
      expect(found?.description).toBe(description);
    });
  },
);
