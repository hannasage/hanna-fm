import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/support/global-setup.ts"],
    // Test files share one database and one row set, so they run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
