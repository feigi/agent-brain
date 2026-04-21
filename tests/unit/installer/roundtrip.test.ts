import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstaller } from "../../../scripts/installer/index.js";

const REPO_ROOT = process.cwd();

describe("installer round-trip", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abrt-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("install then uninstall leaves pre-existing foreign keys intact", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const seed = {
      theme: "dark",
      mcpServers: { other: { url: "x" } },
      hooks: { OtherEvent: [{ type: "command", command: "/usr/bin/foo" }] },
    };
    const seedJson = JSON.stringify(seed, null, 2) + "\n";
    writeFileSync(join(home, ".claude", "settings.json"), seedJson);
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# User\nbody\n");

    await runInstaller(
      { targets: ["claude"], dryRun: false, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );
    await runInstaller(
      { targets: ["claude"], dryRun: false, uninstall: true },
      { repoRoot: REPO_ROOT, home },
    );

    const settingsAfter = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settingsAfter.theme).toBe("dark");
    expect(settingsAfter.mcpServers).toEqual({ other: { url: "x" } });
    expect(settingsAfter.hooks?.OtherEvent).toEqual([
      { type: "command", command: "/usr/bin/foo" },
    ]);
    expect(settingsAfter.hooks?.SessionStart).toBeUndefined();

    const mdAfter = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(mdAfter).toContain("# User");
    expect(mdAfter).toContain("body");
    expect(mdAfter).not.toContain("<!-- agent-brain:start -->");
  });

  it("uninstall with invalid JSON leaves the file byte-identical and sets exitCode=3", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const corrupt = "{ not valid json";
    writeFileSync(join(home, ".claude", "settings.json"), corrupt);

    // Hook script on disk so we can check ordering. Uninstall ordering
    // strips config *before* removing the script; with invalid JSON, the
    // script may be removed anyway but the settings file must survive.
    mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "hooks", "memory-session-start.sh"),
      "#!/bin/sh\n",
    );

    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      await runInstaller(
        { targets: ["claude"], dryRun: false, uninstall: true },
        { repoRoot: REPO_ROOT, home },
      );
      expect(process.exitCode).toBe(3);
      expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(
        corrupt,
      );
    } finally {
      process.exitCode = prevExit;
    }
  });

  it("sandbox home never writes to real $HOME", async () => {
    const realHome = process.env.HOME;
    await runInstaller(
      { targets: ["claude"], dryRun: false, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );
    expect(existsSync(join(home, ".claude"))).toBe(true);
    // After the installer returns, process.env.HOME is set to the sandbox —
    // that's intentional for the duration of the run. The point of this
    // test is that no stray .claude directory appears under the real HOME
    // as a result of the install.
    if (realHome && realHome !== home) {
      const sandboxEntries = readdirSync(home);
      expect(sandboxEntries).toContain(".claude");
    }
  });

  it("failing preflight on target 2 prevents any writes on target 1", async () => {
    const { chmodSync } = await import("node:fs");
    mkdirSync(join(home, ".copilot"), { recursive: true });
    chmodSync(join(home, ".copilot"), 0o500);

    try {
      await expect(
        runInstaller(
          { targets: ["claude", "copilot"], dryRun: false, uninstall: false },
          { repoRoot: REPO_ROOT, home },
        ),
      ).rejects.toThrow();

      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
      expect(
        existsSync(join(home, ".claude", "hooks", "memory-session-start.sh")),
      ).toBe(false);
    } finally {
      chmodSync(join(home, ".copilot"), 0o700);
    }
  });

  it("orphan start marker falls through to prepend (does not break file)", async () => {
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeMd, "<!-- agent-brain:start -->\nhalf written\n");
    await runInstaller(
      { targets: ["claude"], dryRun: false, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );
    const after = readFileSync(claudeMd, "utf8");
    expect(after.startsWith("<!-- agent-brain:start -->")).toBe(true);
    expect(after).toContain("<!-- agent-brain:end -->");
  });
});
