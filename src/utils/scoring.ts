// D-01, D-02, D-03, D-04: Composite relevance scoring functions
// Pure functions for computing memory relevance from similarity, recency, and verification.

/** D-01: Similarity dominates scoring (80% weight) */
export const SIMILARITY_WEIGHT = 0.8;

/** D-02: Recency contributes 15% via exponential decay */
export const RECENCY_WEIGHT = 0.15;

/** D-03: Verified memories get a 5% boost */
export const VERIFICATION_BOOST = 0.05;

/** D-04: Over-fetch factor for re-ranking (fetch 3x, score, return top N) */
export const OVER_FETCH_FACTOR = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Exponential decay function for recency scoring.
 *
 * Returns 1.0 for age=0, 0.5 at one half-life, 0.25 at two half-lives, etc.
 * Negative ages are clamped to 0 (treated as brand new).
 */
export function exponentialDecay(
  ageDays: number,
  halfLifeDays: number,
): number {
  const clampedAge = Math.max(0, ageDays);
  return Math.pow(0.5, clampedAge / halfLifeDays);
}

/**
 * Compute composite relevance score combining similarity, recency, and verification.
 *
 * Formula: relevance = (0.80 * similarity) + (0.15 * recencyDecay) + (verifiedAt ? 0.05 : 0)
 * Result is clamped to [0, 1].
 *
 * @param similarity - Cosine similarity score (typically 0 to 1, but not enforced)
 * @param createdAt - When the memory was created
 * @param verifiedAt - When the memory was last verified (null if never)
 * @param halfLifeDays - Half-life for recency decay in days
 * @param now - Reference time for age calculation (defaults to current time)
 */
export function computeRelevance(
  similarity: number,
  createdAt: Date,
  verifiedAt: Date | null,
  halfLifeDays: number,
  now?: Date,
): number {
  const referenceTime = now ?? new Date();
  const ageDays = (referenceTime.getTime() - createdAt.getTime()) / MS_PER_DAY;
  const recencyDecay = exponentialDecay(ageDays, halfLifeDays);

  const relevance =
    SIMILARITY_WEIGHT * similarity +
    RECENCY_WEIGHT * recencyDecay +
    (verifiedAt !== null ? VERIFICATION_BOOST : 0);

  return Math.min(1, Math.max(0, relevance));
}
