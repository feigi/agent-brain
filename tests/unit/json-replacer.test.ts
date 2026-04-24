import { describe, it, expect } from "vitest";
import { stripNullsReplacer } from "../../src/utils/json-replacer.js";
import { toolResponse } from "../../src/tools/tool-utils.js";
import express from "express";

function round(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, stripNullsReplacer));
}

describe("stripNullsReplacer", () => {
  it("drops top-level null keys", () => {
    expect(round({ a: 1, b: null, c: "x" })).toEqual({ a: 1, c: "x" });
  });

  it("drops nested null keys inside objects", () => {
    expect(
      round({ outer: { kept: 1, dropped: null, deep: { x: null, y: 2 } } }),
    ).toEqual({ outer: { kept: 1, deep: { y: 2 } } });
  });

  it("drops nulls inside array items", () => {
    expect(
      round({
        items: [
          { a: 1, b: null },
          { a: 2, b: null, c: null },
        ],
      }),
    ).toEqual({ items: [{ a: 1 }, { a: 2 }] });
  });

  it("preserves falsy non-null values", () => {
    expect(round({ zero: 0, no: false, empty: "", arr: [], obj: {} })).toEqual({
      zero: 0,
      no: false,
      empty: "",
      arr: [],
      obj: {},
    });
  });

  it("preserves Date ISO serialization", () => {
    const d = new Date("2026-04-24T12:00:00Z");
    expect(round({ at: d })).toEqual({ at: d.toISOString() });
  });

  it("still drops undefined keys (default behavior)", () => {
    expect(round({ a: 1, b: undefined, c: null })).toEqual({ a: 1 });
  });
});

describe("toolResponse integration", () => {
  it("strips nulls from envelope JSON", () => {
    const envelope = {
      data: {
        id: "abc",
        verified_at: null,
        archived_at: null,
        tags: null,
        metadata: { file: "x", extra: null },
        nested: [{ v: null, kept: "ok" }],
      },
      meta: {
        timing: 5,
        cursor: null,
      },
    };
    const wrapped = toolResponse(envelope as never);
    const parsed = JSON.parse(wrapped.content[0].text);
    expect(parsed).toEqual({
      data: {
        id: "abc",
        metadata: { file: "x" },
        nested: [{ kept: "ok" }],
      },
      meta: { timing: 5 },
    });
  });
});

describe("Express json replacer integration", () => {
  it("strips nulls from res.json when app.set('json replacer', ...) is wired", async () => {
    const app = express();
    app.set("json replacer", stripNullsReplacer);
    app.get("/probe", (_req, res) => {
      res.json({
        data: { id: "1", verified_at: null, archived_at: null },
        meta: { timing: 2, cursor: null },
      });
    });

    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") {
      server.close();
      throw new Error("failed to bind ephemeral port");
    }
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/probe`);
      const body = await res.json();
      expect(body).toEqual({ data: { id: "1" }, meta: { timing: 2 } });
    } finally {
      server.close();
    }
  });
});
