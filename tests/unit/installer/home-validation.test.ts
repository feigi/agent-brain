import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../../../scripts/installer/index.js";

describe("HOME validation in main()", () => {
  const originalHome = process.env.HOME;
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "abhv-"));
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("rejects unset HOME", async () => {
    delete process.env.HOME;
    await expect(main(["--target=claude", "--dry-run"])).rejects.toThrow(
      /HOME environment variable is not set/,
    );
  });

  it("rejects empty HOME", async () => {
    process.env.HOME = "";
    await expect(main(["--target=claude", "--dry-run"])).rejects.toThrow(
      /HOME environment variable is not set/,
    );
  });

  it("rejects filesystem root '/'", async () => {
    process.env.HOME = "/";
    await expect(main(["--target=claude", "--dry-run"])).rejects.toThrow(
      /must not be filesystem root/,
    );
  });

  it("rejects relative HOME", async () => {
    process.env.HOME = "relative/path";
    await expect(main(["--target=claude", "--dry-run"])).rejects.toThrow(
      /must be an absolute path/,
    );
  });

  it("rejects HOME that is not an existing directory", async () => {
    process.env.HOME = join(sandbox, "does-not-exist");
    await expect(main(["--target=claude", "--dry-run"])).rejects.toThrow(
      /is not an existing directory/,
    );
  });

  it("accepts a valid sandbox directory", async () => {
    process.env.HOME = sandbox;
    await expect(
      main(["--target=claude", "--dry-run"]),
    ).resolves.toBeUndefined();
  });
});
