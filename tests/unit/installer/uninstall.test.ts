import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstaller } from "../../../scripts/installer/index.js";

const REPO_ROOT = process.cwd();

describe("installer uninstall", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abuninst-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("removes copied hook scripts for claude", async () => {
    await runInstaller(
      {
        targets: ["claude"],
        dryRun: false,
        uninstall: false,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );
    expect(
      existsSync(join(home, ".claude", "hooks", "memory-session-start.sh")),
    ).toBe(true);

    await runInstaller(
      {
        targets: ["claude"],
        dryRun: false,
        uninstall: true,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );
    expect(
      existsSync(join(home, ".claude", "hooks", "memory-session-start.sh")),
    ).toBe(false);
    expect(existsSync(join(home, ".claude", "hooks", "memory-guard.sh"))).toBe(
      false,
    );
  });

  it("removes agent-brain keys from settings.json, preserves foreign keys", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { url: "x" } } }),
    );

    await runInstaller(
      {
        targets: ["claude"],
        dryRun: false,
        uninstall: false,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );
    await runInstaller(
      {
        targets: ["claude"],
        dryRun: false,
        uninstall: true,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.theme).toBe("dark");
    expect(settings.mcpServers.other).toEqual({ url: "x" });
    expect(settings.mcpServers["agent-brain"]).toBeUndefined();
    if (settings.hooks?.SessionStart) {
      for (const group of settings.hooks.SessionStart as Array<{
        hooks?: Array<{ command?: string }>;
      }>) {
        for (const h of group.hooks ?? []) {
          expect(h.command).not.toMatch(/memory-.*\.sh/);
        }
      }
    }
  });

  it("strips markers from CLAUDE.md, preserves user content", async () => {
    await runInstaller(
      {
        targets: ["claude"],
        dryRun: false,
        uninstall: false,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );
    const before = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(home, ".claude", "CLAUDE.md"),
      before + "\n# User section\nuser body\n",
    );

    await runInstaller(
      {
        targets: ["claude"],
        dryRun: false,
        uninstall: true,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );
    const after = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(after).not.toContain("<!-- agent-brain:start -->");
    expect(after).toContain("# User section");
    expect(after).toContain("user body");
  });

  it("uninstall of never-installed target is a no-op (ENOENT ignored)", async () => {
    await expect(
      runInstaller(
        {
          targets: ["copilot"],
          dryRun: false,
          uninstall: true,
          skipEnvBootstrap: true,
        },
        { repoRoot: REPO_ROOT, home },
      ),
    ).resolves.toBeUndefined();
  });

  it("uninstall of copilot removes both JSON files' agent-brain keys", async () => {
    await runInstaller(
      {
        targets: ["copilot"],
        dryRun: false,
        uninstall: false,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );
    await runInstaller(
      {
        targets: ["copilot"],
        dryRun: false,
        uninstall: true,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );

    const mcp = JSON.parse(
      readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"),
    );
    expect(mcp.mcpServers?.["agent-brain"]).toBeUndefined();
  });

  it("uninstall of vscode removes agent-brain from mcp.json", async () => {
    await runInstaller(
      {
        targets: ["vscode-copilot"],
        dryRun: false,
        uninstall: false,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );
    await runInstaller(
      {
        targets: ["vscode-copilot"],
        dryRun: false,
        uninstall: true,
        skipEnvBootstrap: true,
      },
      { repoRoot: REPO_ROOT, home },
    );

    const { vscodeUserDataDir } =
      await import("../../../scripts/installer/targets/vscode-copilot.js");
    const userDir = vscodeUserDataDir(home);
    const mcp = JSON.parse(readFileSync(join(userDir, "mcp.json"), "utf8"));
    expect(mcp.servers?.["agent-brain"]).toBeUndefined();
  });
});
