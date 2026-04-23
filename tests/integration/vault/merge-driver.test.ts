import { describe, it, expect } from "vitest";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setupBareAndTwoVaults } from "../../contract/repositories/_git-helpers.js";
import { VaultBackend } from "../../../src/backend/vault/index.js";
import { parseMemoryFile } from "../../../src/backend/vault/parser/memory-parser.js";

const DIMS = 32;

async function ensureCliBuilt(): Promise<void> {
  // Anchor on process.cwd() (the repo root) so this check works whether
  // the test runs from the TypeScript source (vitest) or the compiled
  // dist/ copy — both execute with cwd at the project root.
  const expectedPath = join(
    process.cwd(),
    "dist",
    "src",
    "cli",
    "merge-memory.js",
  );
  try {
    await stat(expectedPath);
  } catch {
    throw new Error(
      `Expected compiled CLI at ${expectedPath}. Run \`npx tsc\` before running integration tests.`,
    );
  }
}

function fakeEmbed(): (text: string) => Promise<number[]> {
  return async () => new Array(DIMS).fill(0.01);
}

async function createBackend(
  root: string,
  remoteUrl: string,
): Promise<VaultBackend> {
  return VaultBackend.create({
    root,
    embeddingDimensions: DIMS,
    remoteUrl,
    pushDebounceMs: 10,
    pushBackoffMs: [50, 200],
    embed: fakeEmbed(),
  });
}

describe("merge driver — concurrent frontmatter edits", () => {
  it("merges tag additions from both sides without conflict", async () => {
    await ensureCliBuilt();

    const { bare, vaultA, vaultB, cleanup } = await setupBareAndTwoVaults();
    try {
      const backendA = await createBackend(vaultA, bare);

      // Seed workspace on A.
      await backendA.workspaceRepo.findOrCreate("ws-1");

      // Seed a memory on A with a shared tag, then push.
      const mem = await backendA.memoryRepo.create({
        id: "merge-smoke-1",
        project_id: "p1",
        workspace_id: "ws-1",
        content: "body",
        title: "merge-smoke",
        type: "fact",
        scope: "workspace",
        author: "alice",
        source: null,
        session_id: null,
        metadata: null,
        tags: ["shared"],
        embedding_model: null,
        embedding_dimensions: DIMS,
        version: 1,
        created_at: new Date("2026-04-22T00:00:00Z"),
        updated_at: new Date("2026-04-22T00:00:00Z"),
        verified_at: null,
        archived_at: null,
        comment_count: 0,
        flag_count: 0,
        relationship_count: 0,
        last_comment_at: null,
        verified_by: null,
        embedding: new Array(DIMS).fill(0.01),
      });

      await backendA.flushPushes();

      // Create B only after A has pushed so B's alignWithRemote resets
      // to A's history (unrelated-history bootstrap path), giving both
      // clones the same base commit.
      const backendB = await createBackend(vaultB, bare);

      // B pulls — now both clones share the same base commit.
      await backendB.pullFromRemote();

      // Concurrent edits: A adds "zebra" (sorts last), B adds "alpha" (sorts
      // first). Plain text merge would preserve insertion order and produce
      // ["shared", "zebra", "alpha"]; our custom driver calls unionSorted
      // which sorts the union, giving ["alpha", "shared", "zebra"]. This
      // distinguishes driver-fired from plain-text-merge.
      await backendA.memoryRepo.update(mem.id, mem.version, {
        tags: ["shared", "zebra"],
      });
      await backendB.memoryRepo.update(mem.id, mem.version, {
        tags: ["shared", "alpha"],
      });

      // A pushes first (lands on origin).
      await backendA.flushPushes();

      // B pulls — should rebase B's commit on top of A's via the
      // agent-brain-memory merge driver, producing a clean merge
      // of both tag lists.
      const pulled = await backendB.pullFromRemote();
      expect(pulled.conflict).toBe(false);

      // Parse B's merged file and assert the custom driver ran.
      // Our driver calls unionSorted → Array.from(new Set([...])).sort(),
      // giving ["alpha", "shared", "zebra"]. Plain text merge would instead
      // preserve insertion order, e.g. ["shared", "zebra", "alpha"].
      const path = join(
        vaultB,
        "workspaces",
        "ws-1",
        "memories",
        "merge-smoke-1.md",
      );
      const body = await readFile(path, "utf8");
      const merged = parseMemoryFile(body).memory;
      expect(merged.tags).toEqual(["alpha", "shared", "zebra"]);

      await backendA.close();
      await backendB.close();
    } finally {
      await cleanup();
    }
  }, 60_000);
});
