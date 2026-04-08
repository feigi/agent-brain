import type { Memory } from "../types/memory.js";

/** D-11: Workspace/Project=shared, User=owner only */
export function canAccessMemory(memory: Memory, userId: string): boolean {
  if (memory.scope === "workspace" || memory.scope === "project") return true;
  return memory.author === userId;
}
