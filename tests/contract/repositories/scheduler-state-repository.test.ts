import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { factories, type TestBackend } from "./_factories.js";

describe.each(factories)(
  "SchedulerStateRepository contract — $name",
  (factory) => {
    let backend: TestBackend;
    beforeEach(async () => {
      backend = await factory.create();
    });
    afterEach(async () => {
      await backend.close();
    });

    it("getLastRun returns null before any recordRun", async () => {
      expect(
        await backend.schedulerStateRepo.getLastRun("consolidation"),
      ).toBeNull();
    });

    it("recordRun then getLastRun round-trips", async () => {
      const t = new Date("2026-04-21T10:00:00.000Z");
      await backend.schedulerStateRepo.recordRun("consolidation", t);
      const got = await backend.schedulerStateRepo.getLastRun("consolidation");
      expect(got?.toISOString()).toBe(t.toISOString());
    });

    it("recordRun is monotonic — never regresses on older runAt", async () => {
      const newer = new Date("2026-04-21T10:00:00.000Z");
      const older = new Date("2026-04-20T10:00:00.000Z");
      await backend.schedulerStateRepo.recordRun("consolidation", newer);
      await backend.schedulerStateRepo.recordRun("consolidation", older);
      const got = await backend.schedulerStateRepo.getLastRun("consolidation");
      expect(got?.toISOString()).toBe(newer.toISOString());
    });

    it("recordRun advances to a later runAt", async () => {
      const t1 = new Date("2026-04-21T10:00:00.000Z");
      const t2 = new Date("2026-04-21T11:00:00.000Z");
      await backend.schedulerStateRepo.recordRun("consolidation", t1);
      await backend.schedulerStateRepo.recordRun("consolidation", t2);
      const got = await backend.schedulerStateRepo.getLastRun("consolidation");
      expect(got?.toISOString()).toBe(t2.toISOString());
    });
  },
);
