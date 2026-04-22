import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Smoke test for the production module graph.
 *
 * Vitest transforms modules via esbuild, which papers over CJS/ESM named-import
 * mismatches that the real Node ESM loader rejects (e.g. `import { x } from "cjs-only-pkg"`).
 * Tests can therefore pass while `npm start` crashes on import.
 *
 * This spawns Node with the tsx loader and imports src/server.ts without starting
 * the listener (src/server.ts gates main() behind an entrypoint check). A non-zero
 * exit means a module in the graph failed to resolve under real Node ESM semantics.
 */
describe("server module graph loads under Node ESM", () => {
  it("imports src/server.ts without module-resolution errors", () => {
    const result = spawnSync(
      "node",
      ["--import", "tsx", "-e", "await import('./src/server.js');"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 20_000,
        // Hermetic env: avoid inheriting dev .env DATABASE_URL / CONSOLIDATION_ENABLED.
        env: {
          ...process.env,
          CONSOLIDATION_ENABLED: "false",
          PROJECT_ID: "smoke-test",
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Server module graph failed to load (exit ${result.status}):\n` +
          `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      );
    }
    expect(result.status).toBe(0);
  });

  it(
    "boots under AGENT_BRAIN_BACKEND=vault with AGENT_BRAIN_VAULT_REMOTE_URL",
    { timeout: 40_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "server-boot-vault-"));
      const bare = join(dir, "origin.git");
      const vault = join(dir, "vault");
      try {
        // Initialize a bare git repo to act as the remote.
        const initResult = spawnSync("git", ["init", "--bare", bare], {
          encoding: "utf8",
          timeout: 10_000,
        });
        if (initResult.status !== 0) {
          throw new Error(
            `Failed to init bare repo:\nstderr: ${initResult.stderr}`,
          );
        }

        const result = spawnSync(
          "node",
          ["--import", "tsx", "-e", "await import('./src/server.js');"],
          {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 30_000,
            env: {
              ...process.env,
              CONSOLIDATION_ENABLED: "false",
              PROJECT_ID: "smoke-test-vault",
              AGENT_BRAIN_BACKEND: "vault",
              AGENT_BRAIN_VAULT_ROOT: vault,
              AGENT_BRAIN_VAULT_REMOTE_URL: bare,
              EMBEDDING_PROVIDER: "mock",
            },
          },
        );

        if (result.status !== 0) {
          throw new Error(
            `Server (vault backend) failed to load (exit ${result.status}):\n` +
              `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
          );
        }
        expect(result.status).toBe(0);
        expect(result.stderr).not.toMatch(/vault push failed/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
