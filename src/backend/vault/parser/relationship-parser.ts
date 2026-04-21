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
    const createdAt = new Date(required(kv, "at", line));
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

function formatConfidence(c: number): string {
  const rounded = Math.round(c * 10_000) / 10_000;
  return String(rounded);
}

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
