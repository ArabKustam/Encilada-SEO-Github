import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
    // Recording and rendering are heavy; running those suites side by side makes them time out.
    fileParallelism: process.env.REPOKIT_E2E_MEDIA !== "1",
  },
});
