import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultVectorIndex } from "../../../../src/backend/vault/vector/lance-index.js";
import {
  diffReindex,
  runSessionStart,
} from "../../../../src/backend/vault/session-start.js";
import { serializeMemoryFile } from "../../../../src/backend/vault/parser/memory-parser.js";
import type { Memory } from "../../../../src/types/memory.js";

const DIMS = 768;

async function setup(): Promise<{
  root: string;
  index: VaultVectorIndex;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "reindex-test-"));
  const index = await VaultVectorIndex.create({ root, dims: DIMS });
  return {
    root,
    index,
    cleanup: async () => {
      await index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function makeMemory(id: string, content: string): Memory {
  const now = new Date("2024-01-01T00:00:00Z");
  return {
    id,
    project_id: "proj1",
    workspace_id: "ws1",
    content,
    title: `Memory ${id}`,
    type: "fact",
    scope: "workspace",
    tags: null,
    author: "user1",
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

function fakeMemoryMarkdown(id: string, content: string): string {
  return serializeMemoryFile({
    memory: makeMemory(id, content),
    flags: [],
    comments: [],
    relationships: [],
  });
}

async function writeMemory(
  root: string,
  path: string,
  id: string,
  content: string,
): Promise<void> {
  const abs = join(root, path);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, fakeMemoryMarkdown(id, content));
}

describe("diffReindex", () => {
  it("re-embeds when content hash changed", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let calls = 0;
      const embed = async (text: string) => {
        calls += 1;
        return new Array(DIMS).fill(text.length / 100);
      };
      await writeMemory(root, "workspaces/ws1/memories/m1.md", "m1", "body-v1");
      const r1 = await diffReindex({
        paths: ["workspaces/ws1/memories/m1.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(r1.parseErrors).toEqual([]);
      expect(calls).toBe(1);

      await writeMemory(root, "workspaces/ws1/memories/m1.md", "m1", "body-v2");
      const r2 = await diffReindex({
        paths: ["workspaces/ws1/memories/m1.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(r2.parseErrors).toEqual([]);
      expect(calls).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("skips re-embed when content hash unchanged", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let calls = 0;
      const embed = async (text: string) => {
        calls += 1;
        return new Array(DIMS).fill(text.length / 100);
      };
      await writeMemory(
        root,
        "workspaces/ws1/memories/m1.md",
        "m1",
        "body-stable",
      );
      await diffReindex({
        paths: ["workspaces/ws1/memories/m1.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(calls).toBe(1);
      await diffReindex({
        paths: ["workspaces/ws1/memories/m1.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(calls).toBe(1); // skipped — same hash
    } finally {
      await cleanup();
    }
  });

  it("counts parse errors without aborting", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const embed = async () => new Array(DIMS).fill(0.1);
      await writeMemory(root, "workspaces/ws1/memories/good.md", "good", "ok");
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/bad.md"),
        ":: not YAML ::\n",
      );
      const r = await diffReindex({
        paths: [
          "workspaces/ws1/memories/good.md",
          "workspaces/ws1/memories/bad.md",
        ],
        root,
        vectorIndex: index,
        embed,
      });
      expect(r.parseErrors).toHaveLength(1);
      expect(r.parseErrors[0].path).toBe("workspaces/ws1/memories/bad.md");
      expect(r.parseErrors[0].reason).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("skips non-memory paths", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let calls = 0;
      const embed = async () => {
        calls += 1;
        return new Array(DIMS).fill(0.1);
      };
      const r = await diffReindex({
        paths: [".gitignore", "README.md", "docs/x.md"],
        root,
        vectorIndex: index,
        embed,
      });
      expect(r.parseErrors).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

function fakeSync(result: {
  offline?: boolean;
  conflict?: boolean;
  rebaseWedged?: true;
  changedPaths?: string[];
}) {
  return async () => {
    if (result.offline) return { kind: "offline" as const };
    if (result.conflict) {
      return result.rebaseWedged
        ? { kind: "conflict" as const, rebaseWedged: true as const }
        : { kind: "conflict" as const };
    }
    return { kind: "ok" as const, changedPaths: result.changedPaths ?? [] };
  };
}

function fakePushQueue(unpushed: number | (() => Promise<number>)) {
  return {
    unpushedCommits: async () =>
      typeof unpushed === "number" ? unpushed : await unpushed(),
    request: () => {},
  };
}

describe("runSessionStart", () => {
  it("all-happy returns empty meta", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({}),
        pushQueue: fakePushQueue(0),
      });
      expect(meta).toEqual({});
    } finally {
      await cleanup();
    }
  });

  it("offline surfaces in meta", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({ offline: true }),
        pushQueue: fakePushQueue(0),
      });
      expect(meta.offline).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("conflict surfaces in meta", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({ conflict: true }),
        pushQueue: fakePushQueue(0),
      });
      expect(meta.pull_conflict).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("unpushed > 0 surfaces", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({}),
        pushQueue: fakePushQueue(3),
      });
      expect(meta.unpushed_commits).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("parse errors propagate from diffReindex", async () => {
    const { root, index, cleanup } = await setup();
    try {
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/bad.md"),
        ":: not YAML ::\n",
      );
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({
          changedPaths: ["workspaces/ws1/memories/bad.md"],
        }),
        pushQueue: fakePushQueue(0),
      });
      expect(meta.parse_errors).toHaveLength(1);
      expect(meta.parse_errors?.[0].path).toBe(
        "workspaces/ws1/memories/bad.md",
      );
      expect(meta.parse_errors?.[0].reason).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("kicks pushQueue.request() after collecting meta", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let kicked = 0;
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({}),
        pushQueue: {
          unpushedCommits: async () => 2,
          request: () => {
            kicked += 1;
          },
        },
      });
      expect(kicked).toBe(1);
      expect(meta.unpushed_commits).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("onChangedPaths fires with changedPaths when pull returns non-empty paths", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const received: string[][] = [];
      await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({
          changedPaths: ["workspaces/ws1/memories/x.md"],
        }),
        pushQueue: fakePushQueue(0),
        onChangedPaths: (paths) => {
          received.push(paths);
        },
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(["workspaces/ws1/memories/x.md"]);
    } finally {
      await cleanup();
    }
  });

  it("onChangedPaths does NOT fire when changedPaths is empty", async () => {
    const { root, index, cleanup } = await setup();
    try {
      let callCount = 0;
      await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({ changedPaths: [] }),
        pushQueue: fakePushQueue(0),
        onChangedPaths: () => {
          callCount += 1;
        },
      });
      expect(callCount).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("merges unindexable entries into meta.parse_errors with reason preserved", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({}),
        pushQueue: fakePushQueue(0),
        unindexableEntries: [
          {
            path: "workspaces/ws1/memories/broken.md",
            reason: "Missing frontmatter id",
          },
        ],
      });
      expect(meta.parse_errors).toEqual([
        {
          path: "workspaces/ws1/memories/broken.md",
          reason: "Missing frontmatter id",
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("omits parse_errors when no errors", async () => {
    const { root, index, cleanup } = await setup();
    try {
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({}),
        pushQueue: fakePushQueue(0),
        unindexableEntries: [],
      });
      expect(meta.parse_errors).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("dedupes parse_errors by path, preferring live diffReindex reason over boot snapshot", async () => {
    const { root, index, cleanup } = await setup();
    try {
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/bad.md"),
        ":: not YAML ::\n",
      );
      const meta = await runSessionStart({
        root,
        vectorIndex: index,
        embed: async () => new Array(DIMS).fill(0.1),
        syncFromRemote: fakeSync({
          changedPaths: ["workspaces/ws1/memories/bad.md"],
        }),
        pushQueue: fakePushQueue(0),
        unindexableEntries: [
          {
            path: "workspaces/ws1/memories/bad.md",
            reason: "stale boot reason",
          },
          {
            path: "workspaces/ws1/memories/other.md",
            reason: "Missing frontmatter id",
          },
        ],
      });
      expect(meta.parse_errors).toHaveLength(2);
      // Live diffReindex entry takes precedence for duplicated path.
      const bad = meta.parse_errors?.find(
        (e) => e.path === "workspaces/ws1/memories/bad.md",
      );
      expect(bad?.reason).not.toBe("stale boot reason");
      expect(bad?.reason).toBeTruthy();
      // Boot-only path is kept.
      const other = meta.parse_errors?.find(
        (e) => e.path === "workspaces/ws1/memories/other.md",
      );
      expect(other?.reason).toBe("Missing frontmatter id");
    } finally {
      await cleanup();
    }
  });
});
