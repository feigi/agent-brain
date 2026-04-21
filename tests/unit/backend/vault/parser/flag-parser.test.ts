import { describe, it, expect } from "vitest";
import type { Flag } from "../../../../../src/types/flag.js";
import {
  parseFlags,
  serializeFlags,
} from "../../../../../src/backend/vault/parser/flag-parser.js";

const CTX = { projectId: "proj_x", memoryId: "mem_src" };

function makeFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    id: "f_xyz",
    project_id: "proj_x",
    memory_id: "mem_src",
    flag_type: "verify",
    severity: "needs_review",
    details: { reason: "referenced file may be renamed" },
    resolved_at: null,
    resolved_by: null,
    created_at: new Date("2026-04-21T10:20:00.000Z"),
    ...overrides,
  };
}

describe("parseFlags", () => {
  it("returns [] for undefined / null / missing", () => {
    expect(parseFlags(undefined, CTX)).toEqual([]);
    expect(parseFlags(null, CTX)).toEqual([]);
    expect(parseFlags([], CTX)).toEqual([]);
  });

  it("parses a minimal flag (reason only)", () => {
    const raw = [
      {
        id: "f_xyz",
        type: "verify",
        severity: "needs_review",
        reason: "referenced file may be renamed",
        created: "2026-04-21T10:20:00.000Z",
        resolved: null,
        resolved_by: null,
      },
    ];

    expect(parseFlags(raw, CTX)).toEqual([makeFlag()]);
  });

  it("parses an enriched flag (related, relationship_id, similarity)", () => {
    const raw = [
      {
        id: "f_abc",
        type: "duplicate",
        severity: "auto_resolved",
        reason: "near-duplicate",
        related: "mem_other",
        relationship_id: "r_1",
        similarity: 0.91,
        created: "2026-04-21T10:20:00.000Z",
        resolved: "2026-04-21T10:21:00.000Z",
        resolved_by: "chris",
      },
    ];

    expect(parseFlags(raw, CTX)).toEqual([
      makeFlag({
        id: "f_abc",
        flag_type: "duplicate",
        severity: "auto_resolved",
        details: {
          reason: "near-duplicate",
          related_memory_id: "mem_other",
          relationship_id: "r_1",
          similarity: 0.91,
        },
        resolved_at: new Date("2026-04-21T10:21:00.000Z"),
        resolved_by: "chris",
      }),
    ]);
  });

  it("throws on non-array input that is not null/undefined", () => {
    expect(() => parseFlags("not-an-array", CTX)).toThrow(/flags.*array/i);
    expect(() => parseFlags({}, CTX)).toThrow(/flags.*array/i);
  });

  it("throws on unknown flag type", () => {
    const raw = [
      {
        id: "f_1",
        type: "bogus",
        severity: "needs_review",
        reason: "x",
        created: "2026-04-21T10:20:00.000Z",
        resolved: null,
        resolved_by: null,
      },
    ];
    expect(() => parseFlags(raw, CTX)).toThrow(/\.type invalid/);
  });
});

describe("serializeFlags", () => {
  it("returns [] for empty input", () => {
    expect(serializeFlags([])).toEqual([]);
  });

  it("omits optional detail fields when absent", () => {
    expect(serializeFlags([makeFlag()])).toEqual([
      {
        id: "f_xyz",
        type: "verify",
        severity: "needs_review",
        reason: "referenced file may be renamed",
        created: "2026-04-21T10:20:00.000Z",
        resolved: null,
        resolved_by: null,
      },
    ]);
  });

  it("emits optional detail fields when present", () => {
    const f = makeFlag({
      flag_type: "duplicate",
      details: {
        reason: "near-duplicate",
        related_memory_id: "mem_other",
        relationship_id: "r_1",
        similarity: 0.91,
      },
      resolved_at: new Date("2026-04-21T10:21:00.000Z"),
      resolved_by: "chris",
      severity: "auto_resolved",
    });
    expect(serializeFlags([f])[0]).toMatchObject({
      related: "mem_other",
      relationship_id: "r_1",
      similarity: 0.91,
      resolved: "2026-04-21T10:21:00.000Z",
      resolved_by: "chris",
    });
  });
});
