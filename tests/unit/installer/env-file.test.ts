import { describe, it, expect } from "vitest";
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
