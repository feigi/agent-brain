// tests/integration/vault-watcher-e2e.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBackend } from "../../src/backend/vault/index.js";
import type { Memory } from "../../src/types/memory.js";

async function until<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 8000,
  intervalMs = 100,
): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`until(): timed out after ${timeoutMs}ms`);
}

const stubEmbed = (text: string): number[] => {
  const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
  return [seed % 100, (seed * 7) % 100, (seed * 13) % 100, (seed * 17) % 100];
};

function makeMd(id: string, body = "External body.", title = id): string {
  return `---
id: ${id}
title: ${title}
type: pattern
scope: workspace
workspace_id: ws
project_id: test-project
author: alice
source: agent-auto
session_id: null
tags: null
version: 1
created: '2026-04-25T00:00:00.000Z'
updated: '2026-04-25T00:00:00.000Z'
verified: null
verified_by: null
archived: null
embedding_model: stub
embedding_dimensions: 4
metadata: null
flags: []
---

# ${title}

${body}
`;
}

function makeMemory(
  id: string,
  content = "Internal body content",
): Memory & { embedding: number[] } {
  const now = new Date("2026-04-25T00:00:00.000Z");
  return {
    id,
    project_id: "test-project",
    workspace_id: "ws",
    content,
    title: id,
    type: "pattern",
    scope: "workspace",
    tags: null,
    author: "alice",
    source: "agent-auto",
    session_id: null,
    metadata: null,
    embedding_model: "stub",
    embedding_dimensions: 4,
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
    embedding: stubEmbed(content),
  };
}

describe("vault watcher E2E", { timeout: 15_000 }, () => {
  let root: string;
  let backend: VaultBackend;
  let embedCalls: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ab-watcher-e2e-"));
    embedCalls = 0;
    backend = await VaultBackend.create({
      root,
      projectId: "test-project",
      embeddingDimensions: 4,
      embed: async (text: string) => {
        embedCalls++;
        return stubEmbed(text);
      },
    });
  });

  afterEach(async () => {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });

  it("external add → memory becomes findable", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ext-add.md"), makeMd("ext-add"));

    const found = await until(async () => {
      const m = await backend.memoryRepo.findById("ext-add");
      return m ? m : undefined;
    });
    expect(found.id).toBe("ext-add");
  });

  it("external edit of body → embed called again (re-embed fired)", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "ext-edit.md");
    await writeFile(path, makeMd("ext-edit", "First version of the body."));

    await until(async () =>
      (await backend.memoryRepo.findById("ext-edit")) ? true : undefined,
    );
    const callsAfterAdd = embedCalls;

    // External edit: change the body so a re-embed must fire.
    await writeFile(
      path,
      makeMd("ext-edit", "Completely different second version."),
    );

    await until(async () => (embedCalls > callsAfterAdd ? true : undefined));
    expect(embedCalls).toBeGreaterThan(callsAfterAdd);
  });

  it("frontmatter-only edit → meta-updated, no re-embed", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "ext-fm.md");
    const body = "Body that stays exactly the same.";
    await writeFile(path, makeMd("ext-fm", body, "Original title"));

    const indexed = await until(async () => {
      const m = await backend.memoryRepo.findById("ext-fm");
      return m && m.title === "Original title" ? m : undefined;
    });
    expect(indexed.title).toBe("Original title");
    const callsAfterIndex = embedCalls;

    // Title-only change: rewrite frontmatter title + H1, body identical.
    // Reconciler hashes the body (post-H1 content), so hash stays equal —
    // this exercises the meta-updated branch.
    await writeFile(path, makeMd("ext-fm", body, "Renamed title"));

    const renamed = await until(async () => {
      const m = await backend.memoryRepo.findById("ext-fm");
      return m && m.title === "Renamed title" ? m : undefined;
    });
    expect(renamed.title).toBe("Renamed title");
    // Critical assertion: no re-embed fired for an FM-only change.
    expect(embedCalls).toBe(callsAfterIndex);
  });

  it("external rm → memory disappears from findById", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "ext-rm.md");
    await writeFile(path, makeMd("ext-rm"));

    await until(async () =>
      (await backend.memoryRepo.findById("ext-rm")) ? true : undefined,
    );

    await rm(path);

    const gone = await until(async () => {
      const m = await backend.memoryRepo.findById("ext-rm");
      return m === null ? true : undefined;
    });
    expect(gone).toBe(true);
  });

  it("internal create does NOT trigger a duplicate reindex (IgnoreSet works)", async () => {
    const callsBefore = embedCalls;
    await backend.memoryRepo.create(makeMemory("int-create"));

    // Wait long enough for chokidar awaitWriteFinish (300ms) + grace (500ms).
    await new Promise((r) => setTimeout(r, 1200));

    // Internal create: backend's own create() doesn't call our embed (it
    // takes embedding as an arg), and the watcher should skip the resulting
    // chokidar event because of IgnoreSet. So embedCalls should be unchanged.
    expect(embedCalls).toBe(callsBefore);
  });

  it("boot scan repairs state after kill mid-edit", async () => {
    const dir = join(root, "workspaces/ws/memories");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "boot-test.md");
    await writeFile(path, makeMd("boot-test", "Original body."));

    await until(async () =>
      (await backend.memoryRepo.findById("boot-test")) ? true : undefined,
    );

    // Simulate kill: close the backend, edit the file while down, re-open.
    await backend.close();

    await writeFile(
      path,
      makeMd("boot-test", "Body changed while backend down."),
    );

    backend = await VaultBackend.create({
      root,
      projectId: "test-project",
      embeddingDimensions: 4,
      embed: async (text: string) => {
        embedCalls++;
        return stubEmbed(text);
      },
    });

    // After boot scan, findById should reflect the new body.
    const m = await backend.memoryRepo.findById("boot-test");
    expect(m).not.toBeNull();
    expect(m?.content).toContain("changed while backend down");
  });
});
