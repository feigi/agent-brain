import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndex } from "../../../../../src/backend/vault/repositories/vault-index.js";

async function writeMemoryFile(
  root: string,
  relPath: string,
  id: string,
  extras: Record<string, string> = {},
): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  const fmEntries = [
    `id: ${id}`,
    ...Object.entries(extras).map(([k, v]) => `${k}: ${v}`),
  ];
  const content = `---\n${fmEntries.join("\n")}\n---\nBody of ${id}\n`;
  await writeFile(abs, content, "utf8");
}

describe("VaultIndex", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vault-index-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("create", () => {
    it("builds index from frontmatter ids", async () => {
      await writeMemoryFile(
        root,
        "workspaces/ws1/memories/my-note.md",
        "abc123",
      );
      await writeMemoryFile(root, "project/memories/global-note.md", "def456");

      const idx = await VaultIndex.create(root);
      expect(idx.size).toBe(2);
      expect(idx.resolve("abc123")).toBe("workspaces/ws1/memories/my-note.md");
      expect(idx.resolve("def456")).toBe("project/memories/global-note.md");
    });

    it("skips files without frontmatter id", async () => {
      const abs = join(root, "workspaces/ws1/memories/no-id.md");
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "---\ntitle: Oops\n---\nno id\n", "utf8");

      const idx = await VaultIndex.create(root);
      expect(idx.size).toBe(0);
    });

    it("keeps first occurrence on duplicate ids", async () => {
      await writeMemoryFile(root, "workspaces/ws1/memories/first.md", "dup-id");
      await writeMemoryFile(
        root,
        "workspaces/ws1/memories/second.md",
        "dup-id",
      );

      const idx = await VaultIndex.create(root);
      expect(idx.size).toBe(1);
      expect(idx.resolve("dup-id")).toBe("workspaces/ws1/memories/first.md");
    });

    it("returns empty index when root does not exist", async () => {
      const idx = await VaultIndex.create(join(root, "nonexistent"));
      expect(idx.size).toBe(0);
    });

    it("parses scope from path", async () => {
      await writeMemoryFile(root, "workspaces/ws1/memories/note.md", "ws-mem");
      await writeMemoryFile(root, "project/memories/note.md", "proj-mem");
      await writeMemoryFile(root, "users/alice/ws1/note.md", "user-mem");

      const idx = await VaultIndex.create(root);
      expect(idx.get("ws-mem")?.scope).toBe("workspace");
      expect(idx.get("ws-mem")?.workspaceId).toBe("ws1");
      expect(idx.get("proj-mem")?.scope).toBe("project");
      expect(idx.get("user-mem")?.scope).toBe("user");
      expect(idx.get("user-mem")?.userId).toBe("alice");
    });
  });

  describe("register / unregister", () => {
    it("register adds and unregister removes", async () => {
      const idx = await VaultIndex.create(root);
      idx.register("new-id", {
        path: "workspaces/ws1/new.md",
        scope: "workspace",
        workspaceId: "ws1",
        userId: null,
      });
      expect(idx.has("new-id")).toBe(true);
      expect(idx.resolve("new-id")).toBe("workspaces/ws1/new.md");

      idx.unregister("new-id");
      expect(idx.has("new-id")).toBe(false);
      expect(idx.resolve("new-id")).toBeNull();
    });
  });

  describe("move", () => {
    it("updates path for existing entry", async () => {
      await writeMemoryFile(
        root,
        "workspaces/ws1/memories/old-name.md",
        "move-me",
      );
      const idx = await VaultIndex.create(root);

      idx.move("move-me", "workspaces/ws1/memories/new-name.md");
      expect(idx.resolve("move-me")).toBe(
        "workspaces/ws1/memories/new-name.md",
      );
    });
  });

  describe("slugForTitle", () => {
    it("generates a slug from title", async () => {
      const idx = await VaultIndex.create(root);
      const slug = idx.slugForTitle("My Great Note", "workspaces/ws1/memories");
      expect(slug).toBe("my-great-note");
    });

    it("returns base slug when no collision", async () => {
      await writeMemoryFile(
        root,
        "workspaces/ws1/memories/other-file.md",
        "other",
      );
      const idx = await VaultIndex.create(root);
      const slug = idx.slugForTitle("No Collision", "workspaces/ws1/memories");
      expect(slug).toBe("no-collision");
    });

    it("appends suffix on collision", async () => {
      await writeMemoryFile(
        root,
        "workspaces/ws1/memories/my-note.md",
        "existing",
      );
      const idx = await VaultIndex.create(root);
      const slug = idx.slugForTitle("My Note", "workspaces/ws1/memories");
      expect(slug).not.toBe("my-note");
      expect(slug).toMatch(/^my-note-.{4}$/);
    });
  });

  describe("syncPaths", () => {
    it("adds new files found on disk", async () => {
      const idx = await VaultIndex.create(root);
      expect(idx.size).toBe(0);

      await writeMemoryFile(
        root,
        "workspaces/ws1/memories/synced.md",
        "synced-id",
      );
      await idx.syncPaths(root, ["workspaces/ws1/memories/synced.md"]);

      expect(idx.has("synced-id")).toBe(true);
      expect(idx.resolve("synced-id")).toBe(
        "workspaces/ws1/memories/synced.md",
      );
    });

    it("removes entries for deleted files", async () => {
      await writeMemoryFile(
        root,
        "workspaces/ws1/memories/to-delete.md",
        "del-id",
      );
      const idx = await VaultIndex.create(root);
      expect(idx.has("del-id")).toBe(true);

      await rm(join(root, "workspaces/ws1/memories/to-delete.md"));
      await idx.syncPaths(root, ["workspaces/ws1/memories/to-delete.md"]);

      expect(idx.has("del-id")).toBe(false);
    });

    it("updates entry when file is overwritten with new id", async () => {
      await writeMemoryFile(root, "workspaces/ws1/memories/note.md", "old-id");
      const idx = await VaultIndex.create(root);

      await writeMemoryFile(root, "workspaces/ws1/memories/note.md", "new-id");
      await idx.syncPaths(root, ["workspaces/ws1/memories/note.md"]);

      expect(idx.has("new-id")).toBe(true);
      expect(idx.resolve("new-id")).toBe("workspaces/ws1/memories/note.md");
    });
  });

  describe("checkPathConsistency", () => {
    it("returns empty for consistent entries", async () => {
      await writeMemoryFile(root, "workspaces/ws1/memories/note.md", "ok-id");
      const idx = await VaultIndex.create(root);

      const mismatches = idx.checkPathConsistency();
      expect(mismatches).toEqual([]);
    });

    it("detects scope mismatch", async () => {
      const idx = await VaultIndex.create(root);

      // Register entry with scope that doesn't match directory
      idx.register("mismatch-id", {
        path: "workspaces/ws1/memories/note.md",
        scope: "project",
        workspaceId: "ws1",
        userId: null,
      });

      const mismatches = idx.checkPathConsistency();
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.memoryId).toBe("mismatch-id");
      expect(mismatches[0]!.reason).toContain("scope");
    });

    it("detects workspace mismatch", async () => {
      const idx = await VaultIndex.create(root);

      // Register entry where workspace doesn't match directory
      idx.register("ws-mismatch", {
        path: "workspaces/ws1/memories/note.md",
        scope: "workspace",
        workspaceId: "ws2",
        userId: null,
      });

      const mismatches = idx.checkPathConsistency();
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.memoryId).toBe("ws-mismatch");
      expect(mismatches[0]!.reason).toContain("workspace_id");
    });
  });

  describe("entries / keys", () => {
    it("iterates all entries", async () => {
      await writeMemoryFile(root, "workspaces/ws1/memories/a.md", "id-a");
      await writeMemoryFile(root, "workspaces/ws1/memories/b.md", "id-b");
      const idx = await VaultIndex.create(root);

      const ids = [...idx.keys()];
      expect(ids).toContain("id-a");
      expect(ids).toContain("id-b");

      const allEntries = [...idx.entries()];
      expect(allEntries).toHaveLength(2);
    });
  });

  describe("unindexable tracking", () => {
    it("tracks files with broken YAML", async () => {
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/bad.md"),
        "---\n[invalid yaml\n---\nBody",
      );
      const idx = await VaultIndex.create(root);
      expect(idx.unindexable).toHaveLength(1);
      expect(idx.unindexable[0]!.path).toBe("workspaces/ws1/memories/bad.md");
      expect(idx.unindexable[0]!.reason).toMatch(/parse|frontmatter/i);
    });

    it("tracks files without frontmatter id", async () => {
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/no-id.md"),
        "---\ntitle: oops\n---\nBody\n",
      );
      const idx = await VaultIndex.create(root);
      expect(idx.unindexable).toHaveLength(1);
      expect(idx.unindexable[0]!.reason).toMatch(/id/i);
    });

    it("indexes valid files alongside unindexable ones", async () => {
      await writeMemoryFile(root, "workspaces/ws1/memories/good.md", "mem-1");
      await mkdir(join(root, "workspaces/ws1/memories"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/memories/bad.md"),
        "---\n[broken yaml\n---\nBody",
      );
      const idx = await VaultIndex.create(root);
      expect(idx.size).toBe(1);
      expect(idx.unindexable).toHaveLength(1);
    });

    it("does not track non-memory files as unindexable", async () => {
      // _workspace.md is skipped by inferScopeFromPath returning null
      await mkdir(join(root, "workspaces/ws1"), { recursive: true });
      await writeFile(
        join(root, "workspaces/ws1/_workspace.md"),
        "not a memory",
      );
      const idx = await VaultIndex.create(root);
      expect(idx.unindexable).toHaveLength(0);
    });
  });
});
