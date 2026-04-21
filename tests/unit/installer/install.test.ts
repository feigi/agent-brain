import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstaller } from "../../../scripts/installer/index.js";

const REPO_ROOT = process.cwd();

describe("installer end-to-end", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abhome-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("installs Claude target: copies hooks, merges settings, prepends CLAUDE.md", async () => {
    await runInstaller(
      { targets: ["claude"], dryRun: false, yes: true, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );

    const hooksDir = join(home, ".claude", "hooks");
    expect(existsSync(join(hooksDir, "memory-session-start.sh"))).toBe(true);
    expect(
      statSync(join(hooksDir, "memory-session-start.sh")).mode & 0o111,
    ).not.toBe(0);

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.mcpServers["agent-brain"]).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();

    const claudeMd = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("<!-- agent-brain:start -->");
    expect(claudeMd).toContain("agent-brain");
  });

  it("installs Copilot target: copies hooks, merges two JSON files, prepends instructions", async () => {
    await runInstaller(
      { targets: ["copilot"], dryRun: false, yes: true, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );

    const hooksDir = join(home, ".copilot", "hooks");
    expect(existsSync(join(hooksDir, "memory-pretool.sh"))).toBe(true);

    const mcpCfg = JSON.parse(
      readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"),
    );
    expect(mcpCfg.mcpServers["agent-brain"]).toBeDefined();

    const hooksCfg = JSON.parse(
      readFileSync(join(home, ".copilot", "hooks", "hooks.json"), "utf8"),
    );
    expect(hooksCfg.version).toBe(1);

    const instr = readFileSync(
      join(home, ".copilot", "copilot-instructions.md"),
      "utf8",
    );
    expect(instr).toContain("<!-- agent-brain:start -->");
  });

  it("is idempotent: running install twice produces no duplicates", async () => {
    const opts = {
      targets: ["claude" as const],
      dryRun: false,
      yes: true,
      uninstall: false,
    };
    await runInstaller(opts, { repoRoot: REPO_ROOT, home });
    await runInstaller(opts, { repoRoot: REPO_ROOT, home });

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.SessionStart).toHaveLength(1);

    const claudeMd = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    const starts = claudeMd.match(/<!-- agent-brain:start -->/g) ?? [];
    expect(starts).toHaveLength(1);
  });

  it("dryRun writes nothing", async () => {
    await runInstaller(
      { targets: ["claude"], dryRun: true, yes: true, uninstall: false },
      { repoRoot: REPO_ROOT, home },
    );

    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
  });
});
