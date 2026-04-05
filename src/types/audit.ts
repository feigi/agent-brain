export type AuditAction =
  | "created"
  | "updated"
  | "archived"
  | "merged"
  | "flagged"
  | "commented";

export interface AuditEntry {
  id: string;
  project_id: string;
  memory_id: string;
  action: AuditAction;
  actor: string;
  reason: string | null;
  diff: Record<string, unknown> | null;
  created_at: Date;
}
