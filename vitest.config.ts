import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["fixtures/**", "frontend/**", "node_modules/**", "dist/**"]
  }
});
