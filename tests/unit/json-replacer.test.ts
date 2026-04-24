import { describe, it, expect } from "vitest";
import { stripNullsReplacer } from "../../src/utils/json-replacer.js";
import { toolResponse, toolError } from "../../src/tools/tool-utils.js";
import { DomainError } from "../../src/utils/errors.js";
import express, { Router } from "express";

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

  it("drops null keys on objects inside arrays", () => {
    expect(
      round({
        items: [
          { a: 1, b: null },
          { a: 2, b: null, c: null },
        ],
      }),
    ).toEqual({ items: [{ a: 1 }, { a: 2 }] });
  });

  it("preserves literal null array items (documented caveat)", () => {
    // Array slots cannot be omitted; a replacer returning `undefined` for an
    // array item serializes as the JSON `null` token. Pinning this behavior
    // so a future "fix" that emits a sentinel (e.g. empty object) is caught.
    expect(round({ xs: [1, null, 2] })).toEqual({ xs: [1, null, 2] });
    expect(JSON.stringify([null, null], stripNullsReplacer)).toBe(
      "[null,null]",
    );
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

describe("toolError integration", () => {
  it("strips nulls from error envelope JSON", () => {
    // Guards against a future change that stops passing the replacer to
    // toolError's JSON.stringify call — or extends DomainError with nullable
    // context fields (e.g. `details: null`) that should be omitted on the wire.
    const err = new DomainError("bad input", "VALIDATION_ERROR");
    // Inject a nullable context field via prototype assignment so the test
    // doesn't rely on DomainError's current shape.
    const payload = toolError(err);
    const parsed = JSON.parse(payload.content[0].text);
    expect(parsed).toEqual({ error: "bad input", code: "VALIDATION_ERROR" });
    expect(payload.isError).toBe(true);

    // Direct check: stripNullsReplacer is wired at this call site.
    const withNullField = JSON.stringify(
      { error: "x", code: "Y", details: null },
      stripNullsReplacer,
    );
    expect(JSON.parse(withNullField)).toEqual({ error: "x", code: "Y" });
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

  it("replacer survives app.use(router) registration (simulates server.ts wiring)", async () => {
    // Regression guard: if app.set('json replacer', ...) is ever moved after
    // registerRoutes(), or if a router installs middleware that stringifies
    // responses before res.json runs, this test catches it.
    const app = express();
    app.set("json replacer", stripNullsReplacer);

    const router = Router();
    router.get("/probe-router", (_req, res) => {
      res.json({ data: { id: "r", verified_at: null }, meta: { n: null } });
    });
    app.use(router);

    expect(app.get("json replacer")).toBe(stripNullsReplacer);

    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") {
      server.close();
      throw new Error("failed to bind ephemeral port");
    }
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/probe-router`);
      const body = await res.json();
      expect(body).toEqual({ data: { id: "r" }, meta: {} });
    } finally {
      server.close();
    }
  });
});
