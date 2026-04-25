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
