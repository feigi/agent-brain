import { bench, describe, beforeAll, afterAll } from "vitest";
import { rm, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { VaultBackend } from "../../src/backend/vault/index.js";
import { serializeMemoryFile } from "../../src/backend/vault/parser/memory-parser.js";
import { nanoid } from "nanoid";
import type { Memory } from "../../src/types/memory.js";

const DIMS = 384;

function makeMemory(id: string, wsId: string): Memory {
  const now = new Date();
  return {
    id,
    project_id: "bench-project",
    workspace_id: wsId,
    content: `Benchmark memory content for ${id}`,
    title: `Bench Memory ${id}`,
    type: "fact" as const,
    scope: "workspace" as const,
    tags: null,
    author: "bench-user",
    source: null,
    session_id: null,
    metadata: null,
    embedding_model: null,
    embedding_dimensions: null,
    version: 1,
    created_at: now,
    updated_at: now,
    verified_at: null,
    archived_at: null,
    comment_count: 0,
    flag_count: 0,
    relationship_count: 0,
    last_comment_at: null,
    verified_by: null,
  };
}

async function seedVault(root: string, count: number): Promise<void> {
  const memDir = join(root, "workspaces/bench-ws/memories");
  await mkdir(memDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `seed-${i}`;
    const md = serializeMemoryFile({
      memory: makeMemory(id, "bench-ws"),
      flags: [],
      comments: [],
      relationships: [],
    });
    await writeFile(join(memDir, `mem-${i}.md`), md);
  }
  const git = simpleGit({ baseDir: root });
  await git.add(".");
  await git.commit("seed memories");
}

async function initVaultDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vault-bench-"));
  const git = simpleGit({ baseDir: root });
  await git.init();
  await git.addConfig("user.email", "bench@test.com");
  await git.addConfig("user.name", "Bench");
  // VaultBackend requires a HEAD commit before first push/rebase runs.
  await writeFile(join(root, ".gitignore"), "_vector/\n");
  await git.add(".");
  await git.commit("init");
  return root;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fakeEmbed = async (_: string) => new Array(DIMS).fill(0.1);

describe("vault write path", () => {
  let root: string;
  let backend: VaultBackend;

  beforeAll(async () => {
    root = await initVaultDir();
    backend = await VaultBackend.create({
      root,
      embeddingDimensions: DIMS,
      embed: fakeEmbed,
    });
  });

  afterAll(async () => {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });

  bench(
    "single memory create (empty vault)",
    async () => {
      const id = nanoid();
      const embedding = new Array(DIMS).fill(0.1);
      await backend.memoryRepo.create({
        ...makeMemory(id, "bench-ws"),
        embedding,
      });
    },
    { iterations: 20, warmupIterations: 2 },
  );
});

describe("vault write path (1k existing)", () => {
  let root: string;
  let backend: VaultBackend;

  beforeAll(async () => {
    root = await initVaultDir();
    await seedVault(root, 1000);
    backend = await VaultBackend.create({
      root,
      embeddingDimensions: DIMS,
      embed: fakeEmbed,
    });
  }, 60000);

  afterAll(async () => {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });

  bench(
    "single memory create (1k existing)",
    async () => {
      const id = nanoid();
      const embedding = new Array(DIMS).fill(0.1);
      await backend.memoryRepo.create({
        ...makeMemory(id, "bench-ws"),
        embedding,
      });
    },
    { iterations: 10, warmupIterations: 1 },
  );
});

describe("vault cold start", () => {
  let root1k: string;
  let root10k: string;

  beforeAll(async () => {
    root1k = await initVaultDir();
    await seedVault(root1k, 1000);

    root10k = await initVaultDir();
    await seedVault(root10k, 10000);
  }, 120000);

  afterAll(async () => {
    await rm(root1k, { recursive: true, force: true });
    await rm(root10k, { recursive: true, force: true });
  });

  bench(
    "cold start (1k memories)",
    async () => {
      const b = await VaultBackend.create({
        root: root1k,
        embeddingDimensions: DIMS,
        embed: fakeEmbed,
      });
      await b.close();
    },
    { iterations: 5, warmupIterations: 1 },
  );

  bench(
    "cold start (10k memories)",
    async () => {
      const b = await VaultBackend.create({
        root: root10k,
        embeddingDimensions: DIMS,
        embed: fakeEmbed,
      });
      await b.close();
    },
    { iterations: 3, warmupIterations: 1 },
  );
});
