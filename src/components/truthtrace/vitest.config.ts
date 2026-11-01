import { defineConfig } from "vitest/config";

// C-owned checks can run without changing the shared root CI configuration.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { environment: "node", include: ["src/components/truthtrace/**/*.test.ts"] },
});
