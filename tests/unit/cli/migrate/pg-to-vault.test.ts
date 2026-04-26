import { describe, it, expect, vi } from "vitest";
import { runPgToVault } from "../../../../src/cli/migrate/pg-to-vault.js";

describe("runPgToVault", () => {
  it("writes workspaces before memories before comments/flags/relationships", async () => {
    const calls: string[] = [];
    const fakeSource = {
      readWorkspaces: async () => [{ id: "ws", created_at: new Date() }],
      readMemoriesWithEmbeddings: async () => [
        {
          memory: {
            id: "m1",
            project_id: "p",
            workspace_id: "ws",
            scope: "workspace",
            type: "fact",
            title: "t",
            content: "c",
            tags: [],
            archived: false,
            user_id: "u",
            author: "u",
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
          },
          embedding: [0, 0, 0, 0],
        },
      ],
      readComments: async () => [
        { id: "c1", memory_id: "m1", author: "u", content: "hi" },
      ],
      readFlags: async () => [],
      readRelationships: async () => [],
      counts: async () => ({
        workspaces: 1,
        memories: 1,
        comments: 1,
        flags: 0,
        relationships: 0,
      }),
    };
    const dest = {
      workspaceRepo: {
        findOrCreate: vi.fn(async (slug: string) => {
          calls.push(`ws:${slug}`);
          return { id: slug, created_at: new Date() };
        }),
      },
      memoryRepo: {
        create: vi.fn(async (m: { id: string }) => {
          calls.push(`m:${m.id}`);
          return m;
        }),
      },
      commentRepo: {
        create: vi.fn(async (c: { id: string }) => {
          calls.push(`c:${c.id}`);
          return { ...c, created_at: new Date() };
        }),
      },
      flagRepo: { create: vi.fn() },
      relationshipRepo: { create: vi.fn() },
    };
    await runPgToVault({
      source: fakeSource as never,
      destination: dest as never,
      reembed: false,
      embedder: async () => [0, 0, 0, 0],
    });
    expect(calls).toEqual(["ws:ws", "m:m1", "c:c1"]);
  });

  it("re-embeds when reembed is true", async () => {
    const embedder = vi.fn(async () => [9, 9, 9, 9]);
    const fakeSource = {
      readWorkspaces: async () => [],
      readMemoriesWithEmbeddings: async () => [
        {
          memory: {
            id: "m1",
            project_id: "p",
            workspace_id: "ws",
            scope: "workspace" as const,
            type: "fact",
            title: "t",
            content: "the body",
            tags: [],
            archived: false,
            user_id: "u",
            author: "u",
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
          },
          embedding: [1, 1, 1, 1],
        },
      ],
      readComments: async () => [],
      readFlags: async () => [],
      readRelationships: async () => [],
      counts: async () => ({
        workspaces: 0,
        memories: 1,
        comments: 0,
        flags: 0,
        relationships: 0,
      }),
    };
    let captured: number[] | null = null;
    const dest = {
      workspaceRepo: { findOrCreate: vi.fn() },
      memoryRepo: {
        create: vi.fn(async (m: { embedding: number[] }) => {
          captured = m.embedding;
          return m;
        }),
      },
      commentRepo: { create: vi.fn() },
      flagRepo: { create: vi.fn() },
      relationshipRepo: { create: vi.fn() },
    };
    await runPgToVault({
      source: fakeSource as never,
      destination: dest as never,
      reembed: true,
      embedder,
    });
    expect(embedder).toHaveBeenCalledWith("the body");
    expect(captured).toEqual([9, 9, 9, 9]);
  });

  it("rethrows row write failures with kind+id context", async () => {
    const fakeSource = {
      readWorkspaces: async () => [{ id: "ws", created_at: new Date() }],
      readMemoriesWithEmbeddings: async () => [],
      readComments: async () => [],
      readFlags: async () => [],
      readRelationships: async () => [],
      counts: async () => ({
        workspaces: 1,
        memories: 0,
        comments: 0,
        flags: 0,
        relationships: 0,
      }),
    };
    const dest = {
      workspaceRepo: {
        findOrCreate: vi.fn(async () => {
          throw new Error("disk full");
        }),
      },
      memoryRepo: { create: vi.fn() },
      commentRepo: { create: vi.fn() },
      flagRepo: { create: vi.fn() },
      relationshipRepo: { create: vi.fn() },
    };
    await expect(
      runPgToVault({
        source: fakeSource,
        destination: dest as never,
        reembed: false,
        embedder: async () => [0, 0, 0, 0],
      }),
    ).rejects.toThrow(/kind=workspace id=ws.*disk full/);
  });
});
