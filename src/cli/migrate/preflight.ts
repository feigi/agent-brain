// Phase 6 — preflight checks shared by both migration directions.

export type PreflightResult = { ok: true } | { ok: false; reason: string };

export interface DimCheckInput {
  sourceDim: number;
  destDim: number;
  reembed: boolean;
}

export function checkDims(input: DimCheckInput): PreflightResult {
  if (input.reembed) return { ok: true };
  if (input.sourceDim === input.destDim) return { ok: true };
  return {
    ok: false,
    reason:
      `embedding dim mismatch: source=${input.sourceDim} dest=${input.destDim}. ` +
      `Re-run with --reembed to regenerate vectors via the current EmbeddingProvider.`,
  };
}

export interface TargetEmptyCheckInput {
  countMemories: () => Promise<number>;
}

export async function checkTargetEmpty(
  input: TargetEmptyCheckInput,
): Promise<PreflightResult> {
  const n = await input.countMemories();
  if (n === 0) return { ok: true };
  return {
    ok: false,
    reason:
      `Target database not empty (memories table has ${n} rows). ` +
      `To proceed: TRUNCATE the agent-brain tables in the target schema, or ` +
      `point AGENT_BRAIN_DATABASE_URL at a fresh database, then re-run.`,
  };
}
