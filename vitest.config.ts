import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["fixtures/**", "node_modules/**", "dist/**"]
  }
});
