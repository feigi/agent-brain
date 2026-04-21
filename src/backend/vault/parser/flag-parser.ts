import type { Flag, FlagType, FlagSeverity } from "../../../types/flag.js";

const FLAG_TYPES: FlagType[] = [
  "duplicate",
  "contradiction",
  "override",
  "superseded",
  "verify",
];
const FLAG_SEVERITIES: FlagSeverity[] = ["auto_resolved", "needs_review"];

interface ParseCtx {
  projectId: string;
  memoryId: string;
}

export interface FlagFrontmatter {
  id: string;
  type: FlagType;
  severity: FlagSeverity;
  reason: string;
  related?: string;
  relationship_id?: string;
  similarity?: number;
  created: string;
  resolved: string | null;
  resolved_by: string | null;
}

export function parseFlags(raw: unknown, ctx: ParseCtx): Flag[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("flags frontmatter must be an array");
  }

  return raw.map((entry, i) => parseOne(entry, ctx, i));
}

function parseOne(entry: unknown, ctx: ParseCtx, i: number): Flag {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`flags[${i}] must be an object`);
  }
  const e = entry as Record<string, unknown>;

  const flagType = e.type;
  if (
    typeof flagType !== "string" ||
    !FLAG_TYPES.includes(flagType as FlagType)
  ) {
    throw new Error(`flags[${i}].flag_type invalid: ${String(flagType)}`);
  }
  const severity = e.severity;
  if (
    typeof severity !== "string" ||
    !FLAG_SEVERITIES.includes(severity as FlagSeverity)
  ) {
    throw new Error(`flags[${i}].severity invalid: ${String(severity)}`);
  }

  const id = str(e.id, `flags[${i}].id`);
  const reason = str(e.reason, `flags[${i}].reason`);
  const created = str(e.created, `flags[${i}].created`);
  const resolved = nullableStr(e.resolved, `flags[${i}].resolved`);
  const resolvedBy = nullableStr(e.resolved_by, `flags[${i}].resolved_by`);

  const details: Flag["details"] = { reason };
  if (typeof e.related === "string") details.related_memory_id = e.related;
  if (typeof e.relationship_id === "string")
    details.relationship_id = e.relationship_id;
  if (typeof e.similarity === "number") details.similarity = e.similarity;

  return {
    id,
    project_id: ctx.projectId,
    memory_id: ctx.memoryId,
    flag_type: flagType as FlagType,
    severity: severity as FlagSeverity,
    details,
    resolved_at: resolved === null ? null : isoDate(resolved, `flags[${i}].resolved`),
    resolved_by: resolvedBy,
    created_at: isoDate(created, `flags[${i}].created`),
  };
}

export function serializeFlags(flags: Flag[]): FlagFrontmatter[] {
  return flags.map((f) => {
    const out: FlagFrontmatter = {
      id: f.id,
      type: f.flag_type,
      severity: f.severity,
      reason: f.details.reason,
      created: f.created_at.toISOString(),
      resolved: f.resolved_at ? f.resolved_at.toISOString() : null,
      resolved_by: f.resolved_by,
    };
    if (f.details.related_memory_id !== undefined)
      out.related = f.details.related_memory_id;
    if (f.details.relationship_id !== undefined)
      out.relationship_id = f.details.relationship_id;
    if (f.details.similarity !== undefined)
      out.similarity = f.details.similarity;
    return out;
  });
}

function isoDate(v: unknown, name: string): Date {
  if (typeof v !== "string")
    throw new Error(`${name} must be an ISO date string; got ${String(v)}`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new Error(`${name} must be an ISO date string; got ${v}`);
  return d;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be string`);
  return v;
}

function nullableStr(v: unknown, name: string): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  throw new Error(`${name} must be string or null`);
}
