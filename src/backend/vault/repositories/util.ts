type HasCreatedAt = { created_at: Date };

export function compareByCreatedAsc(a: HasCreatedAt, b: HasCreatedAt): number {
  return a.created_at.getTime() - b.created_at.getTime();
}

export function compareByCreatedDesc(a: HasCreatedAt, b: HasCreatedAt): number {
  return b.created_at.getTime() - a.created_at.getTime();
}
