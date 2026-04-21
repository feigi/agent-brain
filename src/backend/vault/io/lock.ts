import lockfile from "proper-lockfile";

// Per-file advisory lock via proper-lockfile's `<path>.lock` sibling
// directory. `retries` handles contention against a live holder (up
// to ~10s worst case); `stale` reclaims a lock whose mtime exceeds
// the threshold, which is how a crashed holder's lock is recovered.
export async function withFileLock<T>(
  absPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(absPath, {
    retries: { retries: 50, minTimeout: 10, maxTimeout: 200 },
    stale: 5_000,
    realpath: false,
  });
  let primary: unknown;
  try {
    return await fn();
  } catch (err) {
    primary = err;
    throw err;
  } finally {
    try {
      await release();
    } catch (releaseErr) {
      // Release failure must not mask the primary error.
      if (primary === undefined) {
        // eslint-disable-next-line no-unsafe-finally
        throw releaseErr;
      }
      // Primary already thrown; swallow release error to avoid masking.
      // Surface it on stderr so ops can spot lock-release anomalies.
      console.warn(
        `proper-lockfile release failed for ${absPath}:`,
        releaseErr,
      );
    }
  }
}
