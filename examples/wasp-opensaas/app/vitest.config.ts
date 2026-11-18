import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "jsdom",
    env: { NODE_ENV: "development" },
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
