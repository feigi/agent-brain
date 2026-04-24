import type { MemoryScope } from "../../../types/memory.js";

// Scope + ownership coordinates derived from a vault path.  The id is
// NOT included — after the switch to title-based filenames, identity
// comes from frontmatter, not the filesystem path.
export interface ScopeLocation {
  scope: MemoryScope;
  workspaceId: string | null;
  userId: string | null;
}

// Everything needed to compute a memory's vault path.
export interface MemoryLocation extends ScopeLocation {
  slug: string;
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

// Returns the scope directory (without trailing filename) for a memory.
export function scopeDir(loc: ScopeLocation): string {
  switch (loc.scope) {
    case "workspace": {
      if (!loc.workspaceId)
        throw new Error("workspace scope requires workspaceId");
      const ws = safeSegment(loc.workspaceId, "workspaceId");
      return `workspaces/${ws}/memories`;
    }
    case "project":
      return `project/memories`;
    case "user": {
      if (!loc.userId) throw new Error("user scope requires userId");
      if (!loc.workspaceId) throw new Error("user scope requires workspaceId");
      const user = safeSegment(loc.userId, "userId");
      const ws = safeSegment(loc.workspaceId, "workspaceId");
      return `users/${user}/${ws}`;
    }
  }
}

export function memoryPath(loc: MemoryLocation): string {
  const slug = safeSegment(loc.slug, "slug");
  return `${scopeDir(loc)}/${slug}.md`;
}

// Derive a filesystem-safe slug from a memory title.
// Lowercase, hyphen-separated, ASCII-only (diacritics stripped via NFKD
// decomposition). Returns "untitled" for titles that produce an empty slug.
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric → hyphens
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .replace(/-{2,}/g, "-"); // collapse consecutive hyphens
  return slug || "untitled";
}

export function workspaceMetaPath(slug: string): string {
  return `workspaces/${safeSegment(slug, "slug")}/_workspace.md`;
}

// Inverse of memoryPath. Returns null for paths that do not match the
// three memory layouts (e.g. `_workspace.md`, root-level files).
// After the title-based filename change, the id is no longer encoded in
// the path — callers must read frontmatter for the stable identity.
export function inferScopeFromPath(relPath: string): ScopeLocation | null {
  const parts = relPath.split("/");
  if (!parts[parts.length - 1]?.endsWith(".md")) return null;

  if (parts[0] === "project" && parts[1] === "memories" && parts.length === 3) {
    return { scope: "project", workspaceId: null, userId: null };
  }
  if (
    parts[0] === "workspaces" &&
    parts[2] === "memories" &&
    parts.length === 4
  ) {
    return {
      scope: "workspace",
      workspaceId: parts[1]!,
      userId: null,
    };
  }
  if (parts[0] === "users" && parts.length === 4) {
    return {
      scope: "user",
      workspaceId: parts[2]!,
      userId: parts[1]!,
    };
  }
  return null;
}
