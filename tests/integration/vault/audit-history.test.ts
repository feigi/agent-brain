import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBackend } from "../../../src/backend/vault/index.js";
import { AuditService } from "../../../src/services/audit-service.js";
import { generateId } from "../../../src/utils/id.js";
import type { Memory } from "../../../src/types/memory.js";

const DIMS = 32;

function makeMemory(
  overrides: Partial<Memory> & Pick<Memory, "id" | "workspace_id">,
): Memory & { embedding: number[] } {
  const now = new Date();
  return {
    project_id: "proj-1",
    content: "initial",
    title: "t",
    type: "fact",
    scope: "workspace",
    tags: ["x"],
    author: "alice",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: null,
    embedding_dimensions: DIMS,
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
    embedding: new Array(DIMS).fill(0.01),
  };
}

describe("vault AuditService.getHistory", () => {
  it("returns create/update/archive entries with correct shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-"));
    const backend = await VaultBackend.create({
      root,
      embeddingDimensions: DIMS,
    });
    const audit = new AuditService(backend.auditRepo, "proj-1");

    // Set up workspace so the path resolves correctly.
    await backend.workspaceRepo.findOrCreate("ws-1");

    const memId = generateId();
    const mem = await backend.memoryRepo.create(
      makeMemory({ id: memId, workspace_id: "ws-1" }),
    );

    const updated = await backend.memoryRepo.update(mem.id, mem.version, {
      content: "updated",
      tags: ["x", "y"],
    });

    await backend.memoryRepo.archive([updated.id]);

    const entries = await audit.getHistory(mem.id);
    expect(entries.map((e) => e.action)).toEqual([
      "archived",
      "updated",
      "created",
    ]);

    const updatedEntry = entries.find((e) => e.action === "updated")!;
    expect(updatedEntry.diff).not.toBeNull();
    expect(updatedEntry.diff).toMatchObject({
      before: { content: "initial", tags: ["x"] },
      after: { content: "updated", tags: ["x", "y"] },
    });

    const createdEntry = entries.find((e) => e.action === "created")!;
    expect(createdEntry.diff).toBeNull();

    await backend.close();
  }, 30_000);
});
