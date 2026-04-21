import { describe, it, expect } from "vitest";
import type { Relationship } from "../../../../../src/types/relationship.js";
import {
  parseRelationshipSection,
  serializeRelationshipSection,
} from "../../../../../src/backend/vault/parser/relationship-parser.js";

const CTX = { projectId: "proj_x", sourceId: "mem_src" };

function makeRel(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: "r_abc",
    project_id: "proj_x",
    source_id: "mem_src",
    target_id: "mem_tgt",
    type: "supersedes",
    description: null,
    confidence: 1,
    created_by: "chris",
    created_via: "manual",
    archived_at: null,
    created_at: new Date("2026-04-21T10:15:00.000Z"),
    ...overrides,
  };
}

describe("parseRelationshipSection", () => {
  it("returns [] for empty section", () => {
    expect(parseRelationshipSection("", CTX)).toEqual([]);
    expect(parseRelationshipSection("\n\n", CTX)).toEqual([]);
  });

  it("parses a line with no description", () => {
    const section =
      "- supersedes:: [[mem_tgt]] — id: r_abc, confidence: 1, by: chris, at: 2026-04-21T10:15:00.000Z, via: manual";

    expect(parseRelationshipSection(section, CTX)).toEqual([makeRel()]);
  });

  it("parses a line with description", () => {
    const section =
      '- related:: [[mem_tgt]] — id: r_def, confidence: 0.8, by: alice, at: 2026-04-21T10:20:00.000Z, via: agent-auto, description: "tangentially connected, kinda"';

    expect(parseRelationshipSection(section, CTX)).toEqual([
      makeRel({
        id: "r_def",
        type: "related",
        description: "tangentially connected, kinda",
        confidence: 0.8,
        created_by: "alice",
        created_via: "agent-auto",
        created_at: new Date("2026-04-21T10:20:00.000Z"),
      }),
    ]);
  });

  it("parses a line with no via (treated as null)", () => {
    const section =
      "- refines:: [[mem_tgt]] — id: r_ghi, confidence: 0.5, by: chris, at: 2026-04-21T10:15:00.000Z";

    expect(parseRelationshipSection(section, CTX)[0]!.created_via).toBeNull();
  });

  it("parses multiple lines", () => {
    const section = [
      "- supersedes:: [[mem_a]] — id: r_1, confidence: 1, by: chris, at: 2026-04-21T10:15:00.000Z, via: manual",
      "- related:: [[mem_b]] — id: r_2, confidence: 0.8, by: chris, at: 2026-04-21T10:16:00.000Z, via: manual",
    ].join("\n");

    expect(parseRelationshipSection(section, CTX)).toHaveLength(2);
  });
});

describe("serializeRelationshipSection", () => {
  it("returns empty string for []", () => {
    expect(serializeRelationshipSection([])).toBe("");
  });

  it("serializes without description when null", () => {
    expect(serializeRelationshipSection([makeRel()])).toBe(
      "- supersedes:: [[mem_tgt]] — id: r_abc, confidence: 1, by: chris, at: 2026-04-21T10:15:00.000Z, via: manual",
    );
  });

  it("serializes with description when present", () => {
    const rel = makeRel({
      description: "a, b",
      confidence: 0.8,
      created_via: null,
    });
    expect(serializeRelationshipSection([rel])).toBe(
      '- supersedes:: [[mem_tgt]] — id: r_abc, confidence: 0.8, by: chris, at: 2026-04-21T10:15:00.000Z, description: "a, b"',
    );
  });

  it("emits confidence with up to 4 decimals, trimmed", () => {
    expect(
      serializeRelationshipSection([makeRel({ confidence: 0.12345 })]),
    ).toContain("confidence: 0.1235");
    expect(
      serializeRelationshipSection([makeRel({ confidence: 0.5 })]),
    ).toContain("confidence: 0.5");
    expect(
      serializeRelationshipSection([makeRel({ confidence: 1 })]),
    ).toContain("confidence: 1");
  });

  it("joins multiple relationships with newline", () => {
    const out = serializeRelationshipSection([
      makeRel({ id: "r_1", target_id: "mem_a" }),
      makeRel({ id: "r_2", target_id: "mem_b", type: "related" }),
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });
});
