import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultAuditRepository } from "../../../../../src/backend/vault/repositories/audit-repository.js";
import { VaultSessionRepository } from "../../../../../src/backend/vault/repositories/session-repository.js";
import { VaultSessionTrackingRepository } from "../../../../../src/backend/vault/repositories/session-tracking-repository.js";

const UNSAFE: readonly string[] = [
  "",
  ".",
  "..",
  "../x",
  "a/b",
  "a\\b",
  "a\0b",
];

describe("traversal rejection for vault secondary repositories", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-traversal-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("VaultAuditRepository.create rejects unsafe memory_id", () => {
    it.each(UNSAFE)("memory_id=%j throws", async (memoryId) => {
      const repo = new VaultAuditRepository({ root });
      await expect(
        repo.create({
          id: "a1",
          project_id: "p1",
          memory_id: memoryId,
          action: "created",
          actor: "chris",
          reason: null,
          diff: null,
          created_at: new Date("2026-04-21T00:00:00.000Z"),
        }),
      ).rejects.toThrow(/invalid memory_id/);
    });

    it.each(UNSAFE)("findByMemoryId(%j) throws", async (memoryId) => {
      const repo = new VaultAuditRepository({ root });
      await expect(repo.findByMemoryId(memoryId)).rejects.toThrow(
        /invalid memory_id/,
      );
    });
  });

  describe("VaultSessionRepository rejects unsafe session id", () => {
    it.each(UNSAFE)("createSession(%j) throws", async (id) => {
      const repo = new VaultSessionRepository({ root });
      await expect(repo.createSession(id, "u1", "p1", "ws1")).rejects.toThrow(
        /invalid session id/,
      );
    });

    it.each(UNSAFE)("incrementBudgetUsed(%j) throws", async (id) => {
      const repo = new VaultSessionRepository({ root });
      await expect(repo.incrementBudgetUsed(id, 10)).rejects.toThrow(
        /invalid session id/,
      );
    });

    it.each(UNSAFE)("findById(%j) throws", async (id) => {
      const repo = new VaultSessionRepository({ root });
      await expect(repo.findById(id)).rejects.toThrow(/invalid session id/);
    });

    it.each(UNSAFE)("getBudget(%j) throws", async (id) => {
      const repo = new VaultSessionRepository({ root });
      await expect(repo.getBudget(id)).rejects.toThrow(/invalid session id/);
    });
  });

  describe("VaultSessionTrackingRepository rejects unsafe segments", () => {
    it.each(UNSAFE)("upsert userId=%j throws", async (value) => {
      const repo = new VaultSessionTrackingRepository({ root });
      await expect(repo.upsert(value, "p1", "ws1")).rejects.toThrow(
        /invalid userId/,
      );
    });

    it.each(UNSAFE)("upsert projectId=%j throws", async (value) => {
      const repo = new VaultSessionTrackingRepository({ root });
      await expect(repo.upsert("u1", value, "ws1")).rejects.toThrow(
        /invalid projectId/,
      );
    });

    it.each(UNSAFE)("upsert workspaceId=%j throws", async (value) => {
      const repo = new VaultSessionTrackingRepository({ root });
      await expect(repo.upsert("u1", "p1", value)).rejects.toThrow(
        /invalid workspaceId/,
      );
    });
  });
});
