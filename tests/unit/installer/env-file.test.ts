import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseDotenv,
  serialize,
  mergeEnv,
  promptFresh,
} from "../../../scripts/installer/env-file.js";

describe("parseDotenv", () => {
  it("parses KEY=VALUE lines", () => {
    const lines = parseDotenv("FOO=bar\nBAZ=qux\n");
    expect(lines).toEqual([
      { kind: "kv", key: "FOO", value: "bar" },
      { kind: "kv", key: "BAZ", value: "qux" },
    ]);
  });

  it("preserves comments verbatim", () => {
    const lines = parseDotenv("# a comment\nFOO=bar\n");
    expect(lines[0]).toEqual({ kind: "comment", raw: "# a comment" });
    expect(lines[1]).toEqual({ kind: "kv", key: "FOO", value: "bar" });
  });

  it("preserves blank lines", () => {
    const lines = parseDotenv("FOO=bar\n\nBAZ=qux\n");
    expect(lines[1]).toEqual({ kind: "blank" });
  });

  it("accepts empty values", () => {
    const lines = parseDotenv("FOO=\n");
    expect(lines).toEqual([{ kind: "kv", key: "FOO", value: "" }]);
  });

  it("accepts values containing '='", () => {
    const lines = parseDotenv("URL=postgresql://a:b@host:5432/db\n");
    expect(lines[0]).toEqual({
      kind: "kv",
      key: "URL",
      value: "postgresql://a:b@host:5432/db",
    });
  });

  it("tolerates missing trailing newline", () => {
    const lines = parseDotenv("FOO=bar");
    expect(lines).toEqual([{ kind: "kv", key: "FOO", value: "bar" }]);
  });

  it("throws with line number for malformed line", () => {
    expect(() => parseDotenv("FOO=bar\nnot a kv line\n")).toThrow(/line 2/);
  });
});

describe("serialize", () => {
  it("emits KEY=VALUE with trailing newline", () => {
    const out = serialize([{ kind: "kv", key: "FOO", value: "bar" }]);
    expect(out).toBe("FOO=bar\n");
  });

  it("preserves comment raw text", () => {
    const out = serialize([
      { kind: "comment", raw: "# hello" },
      { kind: "kv", key: "FOO", value: "bar" },
    ]);
    expect(out).toBe("# hello\nFOO=bar\n");
  });

  it("emits blank lines as empty", () => {
    const out = serialize([
      { kind: "kv", key: "FOO", value: "bar" },
      { kind: "blank" },
      { kind: "kv", key: "BAZ", value: "qux" },
    ]);
    expect(out).toBe("FOO=bar\n\nBAZ=qux\n");
  });

  it("roundtrips canonical .env.example content", () => {
    const input =
      "# Project\nPROJECT_ID=my-project\n\n# DB\nDATABASE_URL=postgresql://a@b/c\n";
    expect(serialize(parseDotenv(input))).toBe(input);
  });
});

describe("mergeEnv", () => {
  const parse = parseDotenv;

  it("fresh (empty existing) emits full template", () => {
    const template = parse("# P\nPROJECT_ID=my-project\nPORT=19898\n");
    const r = mergeEnv([], template);
    expect(serialize(r.lines)).toBe("# P\nPROJECT_ID=my-project\nPORT=19898\n");
    expect(r.added).toEqual(["PROJECT_ID", "PORT"]);
    expect(r.extras).toEqual([]);
    expect(r.changed).toBe(true);
  });

  it("identical existing = no changes", () => {
    const text = "PROJECT_ID=x\nPORT=19898\n";
    const r = mergeEnv(parse(text), parse(text));
    expect(serialize(r.lines)).toBe(text);
    expect(r.added).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it("existing value beats template default for shared key", () => {
    const existing = parse("PROJECT_ID=real-id\nPORT=19898\n");
    const template = parse("PROJECT_ID=my-project\nPORT=19898\n");
    const r = mergeEnv(existing, template);
    expect(serialize(r.lines)).toBe("PROJECT_ID=real-id\nPORT=19898\n");
    expect(r.added).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it("missing key in existing is inserted in template position", () => {
    const existing = parse("PROJECT_ID=x\n");
    const template = parse(
      "# P\nPROJECT_ID=my-project\n# server\nPORT=19898\n",
    );
    const r = mergeEnv(existing, template);
    expect(serialize(r.lines)).toBe(
      "# P\nPROJECT_ID=x\n# server\nPORT=19898\n",
    );
    expect(r.added).toEqual(["PORT"]);
    expect(r.changed).toBe(true);
  });

  it("extras (keys only in existing) are appended under a comment", () => {
    const existing = parse("PROJECT_ID=x\nCUSTOM=keep-me\n");
    const template = parse("PROJECT_ID=my-project\n");
    const r = mergeEnv(existing, template);
    const out = serialize(r.lines);
    expect(out).toContain("# Keys not in .env.example");
    expect(out).toContain("CUSTOM=keep-me");
    expect(r.extras).toEqual(["CUSTOM"]);
    expect(r.changed).toBe(true);
  });

  it("does not add the extras comment when there are no extras", () => {
    const existing = parse("PROJECT_ID=x\n");
    const template = parse("PROJECT_ID=my-project\nPORT=19898\n");
    const r = mergeEnv(existing, template);
    expect(serialize(r.lines)).not.toContain("# Keys not in .env.example");
  });
});

describe("promptFresh", () => {
  function asker(answers: Record<string, string>) {
    return async (q: string) => {
      for (const key of Object.keys(answers)) {
        if (q.includes(key)) return answers[key];
      }
      throw new Error(`Unexpected prompt: ${q}`);
    };
  }

  it("collects PROJECT_ID and EMBEDDING_PROVIDER", async () => {
    const got = await promptFresh(
      asker({ PROJECT_ID: "proj-x", EMBEDDING_PROVIDER: "titan" }),
    );
    expect(got).toEqual({
      PROJECT_ID: "proj-x",
      EMBEDDING_PROVIDER: "titan",
    });
  });

  it("defaults EMBEDDING_PROVIDER to ollama on empty input", async () => {
    const got = await promptFresh(
      asker({ PROJECT_ID: "proj-x", EMBEDDING_PROVIDER: "" }),
    );
    expect(got.EMBEDDING_PROVIDER).toBe("ollama");
  });

  it("rejects empty PROJECT_ID", async () => {
    await expect(
      promptFresh(asker({ PROJECT_ID: "", EMBEDDING_PROVIDER: "ollama" })),
    ).rejects.toThrow(/PROJECT_ID/);
  });

  it("rejects placeholder PROJECT_ID 'my-project'", async () => {
    await expect(
      promptFresh(
        asker({
          PROJECT_ID: "my-project",
          EMBEDDING_PROVIDER: "ollama",
        }),
      ),
    ).rejects.toThrow(/placeholder/);
  });

  it("rejects invalid EMBEDDING_PROVIDER", async () => {
    await expect(
      promptFresh(asker({ PROJECT_ID: "proj-x", EMBEDDING_PROVIDER: "gpt4" })),
    ).rejects.toThrow(/titan|mock|ollama/);
  });
});

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapEnv } from "../../../scripts/installer/env-file.js";

describe("bootstrapEnv (fresh)", () => {
  let dir: string;
  const exampleText =
    "# Project\nPROJECT_ID=my-project\n\n# Embedding\nEMBEDDING_PROVIDER=ollama\nEMBEDDING_DIMENSIONS=768\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envboot-"));
    writeFileSync(join(dir, ".env.example"), exampleText);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .env with answers substituted, no .bak", async () => {
    const logs: string[] = [];
    const plan = await bootstrapEnv(dir, {
      dryRun: false,
      ask: async (q) => {
        if (q.includes("PROJECT_ID")) return "real-proj";
        if (q.includes("EMBEDDING_PROVIDER")) return "titan";
        throw new Error(`unexpected prompt: ${q}`);
      },
      log: (m) => logs.push(m),
    });
    expect(plan.mode).toBe("fresh");
    expect(plan.added).toEqual([
      "PROJECT_ID",
      "EMBEDDING_PROVIDER",
      "EMBEDDING_DIMENSIONS",
    ]);
    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(written).toContain("PROJECT_ID=real-proj");
    expect(written).toContain("EMBEDDING_PROVIDER=titan");
    expect(written).toContain("EMBEDDING_DIMENSIONS=768");
    expect(readdirSync(dir).some((n) => n.startsWith(".env.bak"))).toBe(false);
  });

  it("fresh + dryRun does not write .env", async () => {
    await bootstrapEnv(dir, {
      dryRun: true,
      ask: async () => "real-proj",
      log: () => undefined,
    });
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("throws when .env.example missing", async () => {
    rmSync(join(dir, ".env.example"));
    await expect(
      bootstrapEnv(dir, {
        dryRun: false,
        ask: async () => "x",
        log: () => undefined,
      }),
    ).rejects.toThrow(/\.env\.example/);
  });

  it("throws when repo root is not writable", async () => {
    const { chmodSync } = await import("node:fs");
    chmodSync(dir, 0o555);
    try {
      await expect(
        bootstrapEnv(dir, {
          dryRun: false,
          ask: async () => "real-proj",
          log: () => undefined,
        }),
      ).rejects.toThrow(/writ/i);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe("bootstrapEnv (existing)", () => {
  let dir: string;
  const exampleText =
    "PROJECT_ID=my-project\nEMBEDDING_PROVIDER=ollama\nPORT=19898\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envboot-"));
    writeFileSync(join(dir, ".env.example"), exampleText);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("noop when .env has every template key", async () => {
    writeFileSync(
      join(dir, ".env"),
      "PROJECT_ID=real\nEMBEDDING_PROVIDER=titan\nPORT=19898\n",
    );
    const logs: string[] = [];
    const plan = await bootstrapEnv(dir, {
      dryRun: false,
      ask: async () => {
        throw new Error("should not prompt on merge path");
      },
      log: (m) => logs.push(m),
    });
    expect(plan.mode).toBe("noop");
    expect(plan.added).toEqual([]);
    expect(plan.willBackup).toBe(false);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      "PROJECT_ID=real\nEMBEDDING_PROVIDER=titan\nPORT=19898\n",
    );
    expect(readdirSync(dir).some((n) => n.startsWith(".env.bak"))).toBe(false);
  });

  it("merges missing key, writes backup", async () => {
    writeFileSync(
      join(dir, ".env"),
      "PROJECT_ID=real\nEMBEDDING_PROVIDER=titan\n",
    );
    const plan = await bootstrapEnv(dir, {
      dryRun: false,
      ask: async () => {
        throw new Error("should not prompt on merge path");
      },
      log: () => undefined,
    });
    expect(plan.mode).toBe("merge");
    expect(plan.added).toEqual(["PORT"]);
    expect(plan.willBackup).toBe(true);
    const merged = readFileSync(join(dir, ".env"), "utf8");
    expect(merged).toContain("PROJECT_ID=real");
    expect(merged).toContain("EMBEDDING_PROVIDER=titan");
    expect(merged).toContain("PORT=19898");
    const baks = readdirSync(dir).filter((n) => n.startsWith(".env.bak."));
    expect(baks).toHaveLength(1);
  });

  it("merge + dryRun does not write or backup", async () => {
    writeFileSync(join(dir, ".env"), "PROJECT_ID=real\n");
    const originalEnv = readFileSync(join(dir, ".env"), "utf8");
    await bootstrapEnv(dir, {
      dryRun: true,
      ask: async () => {
        throw new Error("no prompt expected");
      },
      log: () => undefined,
    });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(originalEnv);
    expect(readdirSync(dir).some((n) => n.startsWith(".env.bak"))).toBe(false);
  });

  it("warns when existing PROJECT_ID is placeholder", async () => {
    writeFileSync(
      join(dir, ".env"),
      "PROJECT_ID=my-project\nEMBEDDING_PROVIDER=titan\nPORT=19898\n",
    );
    const plan = await bootstrapEnv(dir, {
      dryRun: false,
      ask: async () => {
        throw new Error("no prompt");
      },
      log: () => undefined,
    });
    expect(plan.warnings.some((w) => w.includes("PROJECT_ID"))).toBe(true);
  });
});
