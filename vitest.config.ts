import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    exclude: ["fixtures/**", "frontend/**", "node_modules/**", "dist/**"]
  }
});
