import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    hookTimeout: 30000,
    testTimeout: 15000,
    fileParallelism: false, // D-64: Integration tests share a single DB; run sequentially
    exclude: ["**/node_modules/**", "**/.worktrees/**", "**/dist/**"],
  },
});
