import { defineConfig, configDefaults } from "vitest/config";

/**
 * Unit tests only (pure functions — fast, no Docker, no network).
 * Integration tests live in test/integration/ and run with
 * `npm run test:integration` (vitest.integration.config.ts).
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/integration/**"],
  },
});
