import lockfile from "proper-lockfile";

// Per-file advisory lock. proper-lockfile creates a `<path>.lock`
// sibling directory atomically; concurrent acquires on the same path
// retry until the existing holder releases. retries.retries guards
// against deadlocks from a crashed holder (stale-lock detection
// reclaims locks older than stale ms).
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
