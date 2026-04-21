import type { Relationship } from "../../../types/relationship.js";
import type { RelationshipParseCtx as ParseCtx } from "./types.js";

const LINE_RE =
  /^- (?<type>[A-Za-z_][A-Za-z0-9_-]*):: \[\[(?<target>[^\]|]+)\]\] — (?<meta>.+)$/;

export function parseRelationshipSection(
  section: string,
  ctx: ParseCtx,
): Relationship[] {
  if (section.trim() === "") return [];

  const out: Relationship[] = [];
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;

    const m = LINE_RE.exec(line);
    if (!m) throw new Error(`Invalid relationship line: ${line}`);

    const { type, target, meta } = m.groups!;
    const kv = parseMeta(meta!);

    const id = required(kv, "id", line);
    const confidenceRaw = required(kv, "confidence", line);
    const confidence = Number(confidenceRaw);
    if (!Number.isFinite(confidence))
      throw new Error(
        `confidence must be a finite number in: ${line}; got ${confidenceRaw}`,
      );
    const createdBy = required(kv, "by", line);
    const atRaw = required(kv, "at", line);
    const createdAt = new Date(atRaw);
    if (Number.isNaN(createdAt.getTime()))
      throw new Error(
        `"at" must be an ISO date string in: ${line}; got ${atRaw}`,
      );
    const createdVia = kv.get("via") ?? null;
    const description = kv.get("description") ?? null;

    out.push({
      id,
      project_id: ctx.projectId,
      source_id: ctx.sourceId,
      target_id: target!,
      type: type!,
      description,
      confidence,
      created_by: createdBy,
      created_via: createdVia,
      archived_at: null,
      created_at: createdAt,
    });
  }
  return out;
}

export function serializeRelationshipSection(rels: Relationship[]): string {
  if (rels.length === 0) return "";
  return rels.map(serializeOne).join("\n");
}

function serializeOne(r: Relationship): string {
  const parts: string[] = [
    `id: ${r.id}`,
    `confidence: ${formatConfidence(r.confidence)}`,
    `by: ${r.created_by}`,
    `at: ${r.created_at.toISOString()}`,
  ];
  if (r.created_via !== null) parts.push(`via: ${r.created_via}`);
  if (r.description !== null)
    parts.push(`description: "${escapeDesc(r.description)}"`);

  return `- ${r.type}:: [[${r.target_id}]] — ${parts.join(", ")}`;
}

function escapeDesc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeDesc(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// 4-decimal precision contract: values are rounded to 1e-4. Callers
// storing higher-precision confidences will observe silent precision
// loss on roundtrip — property tests enforce this by pre-rounding.
function formatConfidence(c: number): string {
  const rounded = Math.round(c * 10_000) / 10_000;
  return String(rounded);
}

// Meta grammar:
//   <k>: <v>, <k>: <v>, ..., description: "<escaped>"
// Description, when present, MUST be the last field — `serializeOne`
// enforces this by emitting it last. Non-description fields are split
// on ", " (naive — no commas in values), so callers storing commas in
// `created_by` / `created_via` / type will shred; property tests use
// metaSafeString (comma-free) to guard. Description supports escaped
// `\"` inside its value via escapeDesc/unescapeDesc.
function parseMeta(meta: string): Map<string, string> {
  const out = new Map<string, string>();
  const descIdx = meta.indexOf(', description: "');
  let head = meta;
  if (descIdx >= 0) {
    head = meta.slice(0, descIdx);
    const descStart = descIdx + ', description: "'.length;
    // Scan for unescaped closing quote.
    let i = descStart;
    let end = -1;
    while (i < meta.length) {
      if (meta[i] === "\\") {
        i += 2;
        continue;
      }
      if (meta[i] === '"') {
        end = i;
        break;
      }
      i += 1;
    }
    if (end <= descStart)
      throw new Error(`Unterminated description in: ${meta}`);
    out.set("description", unescapeDesc(meta.slice(descStart, end)));
  }

  for (const part of head.split(", ")) {
    const colon = part.indexOf(": ");
    if (colon < 0) throw new Error(`Invalid meta fragment: ${part}`);
    out.set(part.slice(0, colon), part.slice(colon + 2));
  }
  return out;
}

function required(kv: Map<string, string>, key: string, line: string): string {
  const v = kv.get(key);
  if (v === undefined) throw new Error(`Missing "${key}" in: ${line}`);
  return v;
}
