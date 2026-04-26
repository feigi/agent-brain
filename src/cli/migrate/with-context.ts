// Wraps a per-row write so failures rethrow with kind+id context.
// Lets the CLI report which entity blew up when the migration aborts
// mid-stream — half-populated targets are recoverable.
export async function withContext<T>(
  kind: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `migration write failed: kind=${kind} id=${id}: ${msg}`,
    );
    if (err instanceof Error && err.stack) wrapped.stack = err.stack;
    throw wrapped;
  }
}
