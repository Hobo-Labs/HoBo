import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "wasp/auth": path.join(root, "test/stubs/wasp-auth.ts"),
      "wasp/client/auth": path.join(root, "test/stubs/wasp-client-auth.ts"),
      "wasp/client/operations": path.join(
        root,
        "test/stubs/wasp-client-operations.ts",
      ),
      "wasp/client/router": path.join(
        root,
        "test/stubs/wasp-client-router.tsx",
      ),
    },
  },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "jsdom",
    env: { NODE_ENV: "development" },
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: process.env.TEST_DATABASE_URL
      ? []
      : ["test/messages.test.ts", "test/admin-profile.test.ts"],
  },
});
