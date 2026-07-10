import { defineConfig } from "vitest/config";

/**
 * Integration tests: real Postgres (throwaway Docker container via
 * testcontainers), mocked external HTTP (Wix / Wave / Meta / Brevo).
 *
 * Requires the Docker daemon to be running. First run pulls
 * postgres:16-alpine (~80 MB); later runs start in a few seconds.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/globalSetup.ts"],
    // Tests share one database — never run files in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    // Container start (and image pull on cold machines) can be slow.
    hookTimeout: 120_000,
  },
});
