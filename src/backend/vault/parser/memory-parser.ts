import matter from "gray-matter";
import type {
  Memory,
  MemoryType,
  MemoryScope,
  Comment,
} from "../../../types/memory.js";
import type { Flag } from "../../../types/flag.js";
import type { Relationship } from "../../../types/relationship.js";
import { parseFlags, serializeFlags } from "./flag-parser.js";
import {
  parseCommentSection,
  serializeCommentSection,
} from "./comment-parser.js";
import {
  parseRelationshipSection,
  serializeRelationshipSection,
} from "./relationship-parser.js";

export interface ParsedMemoryFile {
  memory: Memory;
  flags: Flag[];
  comments: Comment[];
  relationships: Relationship[];
}

const MEMORY_TYPES: MemoryType[] = [
  "fact",
  "decision",
  "learning",
  "pattern",
  "preference",
  "architecture",
];
const MEMORY_SCOPES: MemoryScope[] = ["workspace", "user", "project"];

// Derived-tag asymmetry: each flag emits a `flag/<type>` tag into the
// frontmatter tag list on serialize (for Obsidian tag-pane grouping).
// On parse these are stripped before the tags array is returned, so
// tags round-trip with `flag/*` removed. See serializeMemoryFile.
const FLAG_TAG_RE = /^flag\//;

export function parseMemoryFile(md: string): ParsedMemoryFile {
  const { data: fm, content: body } = matter(md);

  const id = str(fm.id, "id");
  const projectId = str(fm.project_id, "project_id");
  const ctx = { projectId, memoryId: id };

  const flags = parseFlags(fm.flags, ctx);

  const { title, content, relationshipSection, commentSection } =
    splitBody(body);

  if (title !== str(fm.title, "title")) {
    throw new Error(
      `title mismatch: frontmatter="${String(fm.title)}" body="# ${title}"`,
    );
  }

  const relationships = parseRelationshipSection(relationshipSection, {
    projectId,
    sourceId: id,
  });
  const comments = parseCommentSection(commentSection, id);

  const tagsRaw = Array.isArray(fm.tags)
    ? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : null;
  const tags =
    tagsRaw === null ? null : tagsRaw.filter((t) => !FLAG_TAG_RE.test(t));

  const lastCommentAt =
    comments.length === 0
      ? null
      : comments
          .map((c) => c.created_at.getTime())
          .reduce((a, b) => Math.max(a, b));

  const memory: Memory = {
    id,
    project_id: projectId,
    workspace_id: nullableStr(fm.workspace_id, "workspace_id"),
    content,
    title,
    type: enumField(fm.type, MEMORY_TYPES, "type"),
    scope: enumField(fm.scope, MEMORY_SCOPES, "scope"),
    tags,
    author: str(fm.author, "author"),
    source: nullableStr(fm.source, "source"),
    session_id: nullableStr(fm.session_id, "session_id"),
    metadata:
      fm.metadata === null || fm.metadata === undefined
        ? null
        : plainObject(fm.metadata, "metadata"),
    embedding_model: nullableStr(fm.embedding_model, "embedding_model"),
    embedding_dimensions:
      fm.embedding_dimensions === null || fm.embedding_dimensions === undefined
        ? null
        : finiteNumber(fm.embedding_dimensions, "embedding_dimensions"),
    version: finiteNumber(required(fm.version, "version"), "version"),
    created_at: isoDate(fm.created, "created"),
    updated_at: isoDate(fm.updated, "updated"),
    verified_at:
      fm.verified === null || fm.verified === undefined
        ? null
        : isoDate(fm.verified, "verified"),
    archived_at:
      fm.archived === null || fm.archived === undefined
        ? null
        : isoDate(fm.archived, "archived"),
    comment_count: comments.length,
    // Parity with pg: flag_count is unresolved flags only.
    flag_count: flags.filter((f) => f.resolved_at === null).length,
    relationship_count: relationships.length,
    last_comment_at: lastCommentAt === null ? null : new Date(lastCommentAt),
    verified_by: nullableStr(fm.verified_by, "verified_by"),
  };

  return { memory, flags, comments, relationships };
}

export function serializeMemoryFile(input: ParsedMemoryFile): string {
  const { memory, flags, comments, relationships } = input;

  // Derived-tag injection (see FLAG_TAG_RE doc). Null tags + zero flags
  // stay null; otherwise the array materializes with flag/* tags merged.
  const flagTypeTags = Array.from(
    new Set(flags.map((f) => `flag/${f.flag_type}`)),
  );
  const allTags =
    memory.tags === null
      ? flagTypeTags.length === 0
        ? null
        : flagTypeTags
      : [...memory.tags, ...flagTypeTags];

  const fm = {
    id: memory.id,
    title: memory.title,
    type: memory.type,
    scope: memory.scope,
    workspace_id: memory.workspace_id,
    project_id: memory.project_id,
    author: memory.author,
    source: memory.source,
    session_id: memory.session_id,
    tags: allTags,
    version: memory.version,
    created: memory.created_at.toISOString(),
    updated: memory.updated_at.toISOString(),
    verified: memory.verified_at ? memory.verified_at.toISOString() : null,
    verified_by: memory.verified_by,
    archived: memory.archived_at ? memory.archived_at.toISOString() : null,
    embedding_model: memory.embedding_model,
    embedding_dimensions: memory.embedding_dimensions,
    metadata: memory.metadata,
    flags: serializeFlags(flags),
  };

  const parts: string[] = [];
  parts.push(`# ${memory.title}`);
  parts.push("");
  parts.push(memory.content);
  if (relationships.length > 0) {
    parts.push("");
    parts.push("## Relationships");
    parts.push("");
    parts.push(serializeRelationshipSection(relationships));
  }
  if (comments.length > 0) {
    parts.push("");
    parts.push("## Comments");
    parts.push("");
    parts.push(serializeCommentSection(comments));
  }

  return matter.stringify(parts.join("\n"), fm);
}

// Body layout contract:
//   # <title>\n\n<content>\n\n## Relationships\n...\n\n## Comments\n...
// Unknown `## ` headings fold into <content> verbatim — users may
// author arbitrary sections and we never strip them.
//
// Reserved-heading collision: scan from the END of the body so that
// user content containing literal `## Relationships` / `## Comments`
// headings earlier in the text is preserved. Only the last occurrence
// of each reserved heading is treated as a section boundary.
function splitBody(body: string): {
  title: string;
  content: string;
  relationshipSection: string;
  commentSection: string;
} {
  const lines = body.replace(/^\n+/, "").split("\n");
  if (!lines[0]?.startsWith("# ")) {
    throw new Error("body must start with a '# ' title line");
  }
  const title = lines[0].slice(2).trim();

  let rest = lines.slice(1);
  if (rest[0] === "") rest = rest.slice(1);

  const comIdx = rest.lastIndexOf("## Comments");
  const endForRel = comIdx >= 0 ? comIdx : rest.length;
  const relIdx = rest.slice(0, endForRel).lastIndexOf("## Relationships");

  const firstKnown = relIdx >= 0 ? relIdx : comIdx >= 0 ? comIdx : rest.length;
  const content = rest.slice(0, firstKnown).join("\n").replace(/\n+$/, "");

  const trim = (s: string): string => s.replace(/^\n+/, "").replace(/\n+$/, "");

  const relationshipSection =
    relIdx >= 0 ? trim(rest.slice(relIdx + 1, endForRel).join("\n")) : "";
  const commentSection =
    comIdx >= 0 ? trim(rest.slice(comIdx + 1).join("\n")) : "";

  return { title, content, relationshipSection, commentSection };
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}

function nullableStr(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  throw new Error(`${name} must be string or null`);
}

function enumField<T extends string>(
  v: unknown,
  options: readonly T[],
  name: string,
): T {
  if (typeof v !== "string" || !options.includes(v as T)) {
    throw new Error(
      `${name} must be one of ${options.join("|")}; got ${String(v)}`,
    );
  }
  return v as T;
}

function required(v: unknown, name: string): unknown {
  if (v === undefined || v === null)
    throw new Error(`${name} is required in frontmatter`);
  return v;
}

function finiteNumber(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n))
    throw new Error(`${name} must be a finite number; got ${String(v)}`);
  return n;
}

function plainObject(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(`${name} must be an object`);
  return v as Record<string, unknown>;
}

function isoDate(v: unknown, name: string): Date {
  if (typeof v !== "string")
    throw new Error(`${name} must be an ISO date string; got ${String(v)}`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new Error(`${name} must be an ISO date string; got ${v}`);
  return d;
}
