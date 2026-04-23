import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SimpleGit } from "simple-git";
import { VaultAuditRepository } from "../../../../../src/backend/vault/repositories/audit-repository.js";

const PROJECT_ID = "proj-1";

function fakeGit(stubs: {
  log?: (args: string[]) => string;
  show?: (rev: string) => string;
  diffTree?: (sha: string) => string;
}): SimpleGit {
  const raw = vi.fn<(args: string[]) => Promise<string>>(async (args) => {
    if (args[0] === "log") {
      if (!stubs.log) throw new Error("unexpected git log call");
      return stubs.log(args);
    }
    if (args[0] === "show") {
      if (!stubs.show) throw new Error("unexpected git show call");
      return stubs.show(args[1]!);
    }
    if (args[0] === "diff-tree") {
      if (!stubs.diffTree) throw new Error("unexpected git diff-tree call");
      // args: ["diff-tree", "--no-commit-id", "-r", "--name-only", sha]
      const sha = args[args.length - 1]!;
      return stubs.diffTree(sha);
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  });
  return { raw } as unknown as SimpleGit;
}

const memoryMd = (
  over: Partial<{
    title: string;
    content: string;
    updated: string;
    tags: string[];
  }>,
) =>
  [
    "---",
    "id: mem-1",
    `project_id: ${PROJECT_ID}`,
    "workspace_id: ws-1",
    `title: ${over.title ?? "hello"}`,
    "type: fact",
    "scope: workspace",
    `tags: ${JSON.stringify(over.tags ?? ["a", "b"])}`,
    "author: alice",
    "source: manual",
    "session_id: null",
    "metadata: null",
    "embedding_model: null",
    "embedding_dimensions: null",
    "version: 1",
    "created: '2026-04-01T00:00:00.000Z'",
    `updated: '${over.updated ?? "2026-04-20T10:00:00.000Z"}'`,
    "verified: null",
    "archived: null",
    "verified_by: null",
    "---",
    "",
    `# ${over.title ?? "hello"}`,
    "",
    over.content ?? "body-text",
    "",
  ].join("\n");

describe("VaultAuditRepository (git-log reader)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] when git log yields nothing", async () => {
    const git = fakeGit({ log: () => "" });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
    });
    expect(await repo.findByMemoryId("mem-1")).toEqual([]);
  });

  it("parses a single created commit — diff is null", async () => {
    const git = fakeGit({
      log: () =>
        [
          "abc123",
          "2026-04-01T00:00:00.000Z",
          "create\n\nAB-Action: created\nAB-Memory: mem-1\nAB-Actor: alice",
        ].join("\x1f") + "\x1e",
      diffTree: () => "project/memories/mem-1.md\n",
      show: (rev) => {
        if (rev.startsWith("abc123:")) return memoryMd({});
        throw new Error(`unexpected rev ${rev}`);
      },
    });
    const repo = new VaultAuditRepository({ root: "/tmp/vault", git });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      memory_id: "mem-1",
      action: "created",
      actor: "alice",
      reason: null,
      diff: null,
      project_id: PROJECT_ID,
    });
    expect(entries[0]!.created_at).toBeInstanceOf(Date);
  });

  it("reconstructs { before, after } for an update commit (project-scoped memory)", async () => {
    const git = fakeGit({
      log: () =>
        [
          "def456",
          "2026-04-20T10:00:00.000Z",
          "update\n\nAB-Action: updated\nAB-Memory: mem-1\nAB-Actor: bob",
        ].join("\x1f") + "\x1e",
      // diff-tree returns the canonical path; guessCandidatePaths uses this
      // rather than falling back to the unsafe heuristic.
      diffTree: () => "project/memories/mem-1.md\n",
      show: (rev) => {
        if (rev === "def456^:project/memories/mem-1.md")
          return memoryMd({ title: "hello", tags: ["a"] });
        if (rev === "def456:project/memories/mem-1.md")
          return memoryMd({ title: "hello-v2", tags: ["a", "b"] });
        throw new Error(`unexpected rev ${rev}`);
      },
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.project_id).toBe(PROJECT_ID);
    expect(entries[0]!.diff).toEqual({
      before: {
        content: "body-text",
        title: "hello",
        type: "fact",
        tags: ["a"],
        metadata: null,
      },
      after: {
        content: "body-text",
        title: "hello-v2",
        type: "fact",
        tags: ["a", "b"],
        metadata: null,
      },
    });
  });

  it("reconstructs diff for an update commit on a workspace-scoped memory", async () => {
    // Workspace-scoped memories live at workspaces/<ws-id>/memories/<id>.md —
    // diff-tree must return this path so guessCandidatePaths resolves correctly.
    const git = fakeGit({
      log: () =>
        [
          "ghi789",
          "2026-04-21T12:00:00.000Z",
          "update ws\n\nAB-Action: updated\nAB-Memory: mem-1\nAB-Actor: carol",
        ].join("\x1f") + "\x1e",
      diffTree: () => "workspaces/ws-1/memories/mem-1.md\n",
      show: (rev) => {
        if (rev === "ghi789^:workspaces/ws-1/memories/mem-1.md")
          return memoryMd({ title: "before-ws", tags: ["x"] });
        if (rev === "ghi789:workspaces/ws-1/memories/mem-1.md")
          return memoryMd({ title: "after-ws", tags: ["x", "y"] });
        throw new Error(`unexpected rev ${rev}`);
      },
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.project_id).toBe(PROJECT_ID);
    expect(entries[0]!.diff).toEqual({
      before: {
        content: "body-text",
        title: "before-ws",
        type: "fact",
        tags: ["x"],
        metadata: null,
      },
      after: {
        content: "body-text",
        title: "after-ws",
        type: "fact",
        tags: ["x", "y"],
        metadata: null,
      },
    });
  });

  it("returns diff:null (with warn log) when diff-tree fails", async () => {
    // When diff-tree throws (e.g. root commit, git error), guessCandidatePaths
    // should return [] and reconstructUpdateDiff returns null — no silent guess.
    const git = fakeGit({
      log: () =>
        [
          "zzz999",
          "2026-04-21T13:00:00.000Z",
          "update\n\nAB-Action: updated\nAB-Memory: mem-1\nAB-Actor: dave",
        ].join("\x1f") + "\x1e",
      // No diffTree stub — the raw() mock will throw "unexpected git diff-tree call",
      // which guessCandidatePaths catches and converts to an empty candidates list.
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    // diff is null — no silent fallback path guessing
    expect(entries[0]!.diff).toBeNull();
  });

  it("sorts entries newest-first", async () => {
    const git = fakeGit({
      log: () =>
        [
          [
            "aaa",
            "2026-04-01T00:00:00.000Z",
            "x\n\nAB-Action: created\nAB-Memory: mem-1\nAB-Actor: a",
          ].join("\x1f"),
          [
            "bbb",
            "2026-04-02T00:00:00.000Z",
            "x\n\nAB-Action: archived\nAB-Memory: mem-1\nAB-Actor: a",
          ].join("\x1f"),
        ].join("\x1e") + "\x1e",
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries.map((e) => e.action)).toEqual(["archived", "created"]);
  });

  it("create() is a no-op (returns without throwing, no git calls)", async () => {
    const git = fakeGit({});
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
    });
    await repo.create({
      id: "a1",
      project_id: PROJECT_ID,
      memory_id: "mem-1",
      action: "created",
      actor: "alice",
      reason: null,
      diff: null,
      created_at: new Date(),
    });
  });

  it("skips commits whose trailer fails to parse", async () => {
    const git = fakeGit({
      log: () =>
        [
          ["aaa", "2026-04-01T00:00:00.000Z", "garbage-no-trailer"].join(
            "\x1f",
          ),
          [
            "bbb",
            "2026-04-02T00:00:00.000Z",
            "x\n\nAB-Action: created\nAB-Memory: mem-1\nAB-Actor: a",
          ].join("\x1f"),
        ].join("\x1e") + "\x1e",
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("created");
  });

  it("drops commits with unmapped action (e.g. AB-Action: verified)", async () => {
    // Documents the policy: actions not in TRAILER_TO_AUDIT are silently filtered.
    const git = fakeGit({
      log: () =>
        [
          [
            "ccc",
            "2026-04-03T00:00:00.000Z",
            "x\n\nAB-Action: verified\nAB-Memory: mem-1\nAB-Actor: a",
          ].join("\x1f"),
          [
            "ddd",
            "2026-04-04T00:00:00.000Z",
            "x\n\nAB-Action: created\nAB-Memory: mem-1\nAB-Actor: a",
          ].join("\x1f"),
        ].join("\x1e") + "\x1e",
    });
    const repo = new VaultAuditRepository({
      root: "/tmp/vault",
      git,
    });
    const entries = await repo.findByMemoryId("mem-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("created");
  });
});
