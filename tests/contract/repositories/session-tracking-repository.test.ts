import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";

describe.each(factories)(
  "SessionTrackingRepository contract — $name",
  (factory) => {
    let backend: TestBackend;
    beforeEach(async () => {
      backend = await factory.create();
      // pg enforces workspace FK on session_tracking.
      await backend.workspaceRepo.findOrCreate("ws1");
      await backend.workspaceRepo.findOrCreate("ws2");
    });
    afterEach(async () => {
      await backend.close();
    });

    it("first upsert returns null (no previous session)", async () => {
      const prev = await backend.sessionTrackingRepo.upsert("u1", "p1", "ws1");
      expect(prev).toBeNull();
    });

    it("second upsert returns the first session timestamp", async () => {
      const first = new Date();
      await backend.sessionTrackingRepo.upsert("u1", "p1", "ws1");
      // Small wait to ensure the second call's now() is clearly later.
      await new Promise((r) => setTimeout(r, 10));
      const prev = await backend.sessionTrackingRepo.upsert("u1", "p1", "ws1");
      expect(prev).toBeInstanceOf(Date);
      expect(prev!.getTime()).toBeGreaterThanOrEqual(first.getTime() - 1);
    });

    it("different users do not share tracking state", async () => {
      await backend.sessionTrackingRepo.upsert("u1", "p1", "ws1");
      const prev = await backend.sessionTrackingRepo.upsert("u2", "p1", "ws1");
      expect(prev).toBeNull();
    });

    it("different workspaces do not share tracking state", async () => {
      await backend.sessionTrackingRepo.upsert("u1", "p1", "ws1");
      const prev = await backend.sessionTrackingRepo.upsert("u1", "p1", "ws2");
      expect(prev).toBeNull();
    });
  },
);
