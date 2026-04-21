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
    tagsRaw === null
      ? null
      : tagsRaw.filter((t) => !FLAG_TAG_RE.test(t));

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
        : (fm.metadata as Record<string, unknown>),
    embedding_model: nullableStr(fm.embedding_model, "embedding_model"),
    embedding_dimensions:
      fm.embedding_dimensions === null || fm.embedding_dimensions === undefined
        ? null
        : Number(fm.embedding_dimensions),
    version: Number(required(fm.version, "version")),
    created_at: new Date(str(fm.created, "created")),
    updated_at: new Date(str(fm.updated, "updated")),
    verified_at:
      fm.verified === null || fm.verified === undefined
        ? null
        : new Date(String(fm.verified)),
    archived_at:
      fm.archived === null || fm.archived === undefined
        ? null
        : new Date(String(fm.archived)),
    comment_count: comments.length,
    flag_count: flags.length,
    relationship_count: relationships.length,
    last_comment_at: lastCommentAt === null ? null : new Date(lastCommentAt),
    verified_by: nullableStr(fm.verified_by, "verified_by"),
  };

  return { memory, flags, comments, relationships };
}

export function serializeMemoryFile(input: ParsedMemoryFile): string {
  const { memory, flags, comments, relationships } = input;

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

  const relIdx = rest.findIndex((l) => l === "## Relationships");
  const comIdx = rest.findIndex((l) => l === "## Comments");

  const indices = [
    { kind: "relationships" as const, idx: relIdx },
    { kind: "comments" as const, idx: comIdx },
  ]
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  if (indices.length === 2 && indices[0]!.kind !== "relationships") {
    throw new Error("## Relationships must come before ## Comments");
  }

  const firstKnown = indices[0]?.idx ?? rest.length;
  const content = rest.slice(0, firstKnown).join("\n").replace(/\n+$/, "");

  function sliceSection(kind: "relationships" | "comments"): string {
    const start = indices.find((x) => x.kind === kind)?.idx;
    if (start === undefined) return "";
    const next = indices.find((x) => x.idx > start)?.idx ?? rest.length;
    return rest
      .slice(start + 1, next)
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  }

  return {
    title,
    content,
    relationshipSection: sliceSection("relationships"),
    commentSection: sliceSection("comments"),
  };
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
    throw new Error(`${name} must be one of ${options.join("|")}; got ${String(v)}`);
  }
  return v as T;
}

function required(v: unknown, name: string): unknown {
  if (v === undefined || v === null)
    throw new Error(`${name} is required in frontmatter`);
  return v;
}
