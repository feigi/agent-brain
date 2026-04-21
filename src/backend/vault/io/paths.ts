import type { MemoryScope } from "../../../types/memory.js";

export interface MemoryLocation {
  id: string;
  scope: MemoryScope;
  workspaceId: string | null;
  userId: string | null;
}

// Any segment interpolated into a vault path must not contain path
// separators or `.`/`..` traversal tokens — otherwise a crafted id or
// workspace slug could escape the vault root.
export const UNSAFE_SEGMENT = /[/\\]|^\.\.?$|\0/;

export function safeSegment(value: string, name: string): string {
  if (value.length === 0 || UNSAFE_SEGMENT.test(value))
    throw new Error(`invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}

export function memoryPath(loc: MemoryLocation): string {
  const id = safeSegment(loc.id, "id");
  switch (loc.scope) {
    case "workspace": {
      if (!loc.workspaceId)
        throw new Error("workspace scope requires workspaceId");
      const ws = safeSegment(loc.workspaceId, "workspaceId");
      return `workspaces/${ws}/memories/${id}.md`;
    }
    case "project":
      return `project/memories/${id}.md`;
    case "user": {
      if (!loc.userId) throw new Error("user scope requires userId");
      if (!loc.workspaceId) throw new Error("user scope requires workspaceId");
      const user = safeSegment(loc.userId, "userId");
      const ws = safeSegment(loc.workspaceId, "workspaceId");
      return `users/${user}/${ws}/${id}.md`;
    }
  }
}

export function workspaceMetaPath(slug: string): string {
  return `workspaces/${safeSegment(slug, "slug")}/_workspace.md`;
}

// Inverse of memoryPath. Returns null for paths that do not match the
// three memory layouts (e.g. `_workspace.md`, root-level files).
export function inferScopeFromPath(relPath: string): MemoryLocation | null {
  const parts = relPath.split("/");
  if (!parts[parts.length - 1]?.endsWith(".md")) return null;
  const idWithExt = parts[parts.length - 1]!;
  const id = idWithExt.slice(0, -3);

  if (parts[0] === "project" && parts[1] === "memories" && parts.length === 3) {
    return { id, scope: "project", workspaceId: null, userId: null };
  }
  if (
    parts[0] === "workspaces" &&
    parts[2] === "memories" &&
    parts.length === 4
  ) {
    return {
      id,
      scope: "workspace",
      workspaceId: parts[1]!,
      userId: null,
    };
  }
  if (parts[0] === "users" && parts.length === 4) {
    return {
      id,
      scope: "user",
      workspaceId: parts[2]!,
      userId: parts[1]!,
    };
  }
  return null;
}
