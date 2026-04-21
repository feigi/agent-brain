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
  try {
    return await fn();
  } finally {
    await release();
  }
}
