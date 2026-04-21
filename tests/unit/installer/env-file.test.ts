import { describe, it, expect } from "vitest";
import { parseDotenv } from "../../../scripts/installer/env-file.js";

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
