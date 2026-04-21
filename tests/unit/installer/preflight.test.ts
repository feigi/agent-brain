import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkJq,
  checkTargetDirWritable,
  checkDockerWarn,
} from "../../../scripts/installer/preflight.js";

describe("preflight", () => {
  describe("checkJq", () => {
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it("passes when jq on PATH", async () => {
      const stubDir = mkdtempSync(join(tmpdir(), "pfjq-"));
      const jqPath = join(stubDir, "jq");
      writeFileSync(jqPath, "#!/bin/sh\necho stub\n");
      chmodSync(jqPath, 0o755);
      process.env.PATH = stubDir;
      await expect(checkJq()).resolves.toBeUndefined();
      rmSync(stubDir, { recursive: true, force: true });
    });

    it("throws when jq missing", async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "pfnojq-"));
      process.env.PATH = emptyDir;
      await expect(checkJq()).rejects.toThrow(/jq not found/);
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe("checkTargetDirWritable", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "pfdir-"));
    });
    afterEach(() => {
      try {
        chmodSync(dir, 0o755);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    });

    it("passes when dir exists and writable", async () => {
      await expect(checkTargetDirWritable(dir)).resolves.toBeUndefined();
    });

    it("passes when dir missing but parent writable (creates it)", async () => {
      const child = join(dir, "sub");
      await expect(checkTargetDirWritable(child)).resolves.toBeUndefined();
    });

    it("throws when dir not writable", async () => {
      chmodSync(dir, 0o500);
      const child = join(dir, "blocked");
      await expect(checkTargetDirWritable(child)).rejects.toThrow(
        /not writable/,
      );
    });
  });

  describe("checkDockerWarn", () => {
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it("returns null when docker present", async () => {
      const stubDir = mkdtempSync(join(tmpdir(), "pfdocker-"));
      const dockerPath = join(stubDir, "docker");
      writeFileSync(dockerPath, "#!/bin/sh\n");
      chmodSync(dockerPath, 0o755);
      process.env.PATH = stubDir;
      expect(await checkDockerWarn()).toBeNull();
      rmSync(stubDir, { recursive: true, force: true });
    });

    it("returns warning string when docker missing", async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "pfnodocker-"));
      process.env.PATH = emptyDir;
      const result = await checkDockerWarn();
      expect(result).toMatch(/docker not found/);
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });
});
