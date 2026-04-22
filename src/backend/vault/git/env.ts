// Returns a copy of process.env with the GIT_* discovery variables
// removed. When these are set (e.g. by husky pre-commit hooks, rebase,
// or parent git commands), they take precedence over a child process's
// cwd / `git -C` argument — which is how a test that configures
// baseDir to a tmpdir can silently write commits into the outer repo.
// Callers that spawn git must use this so the configured root wins.
//
// PAGER is also cleared: simple-git refuses to run with PAGER set
// unless `allowUnsafePager` is enabled, and the vault backend never
// needs interactive paging.
export function scrubGitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("GIT_")) delete copy[key];
  }
  delete copy.PAGER;
  delete copy.EDITOR;
  delete copy.VISUAL;
  return copy;
}
