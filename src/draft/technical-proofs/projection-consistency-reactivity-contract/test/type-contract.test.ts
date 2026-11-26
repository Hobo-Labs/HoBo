import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tscPath = fileURLToPath(
  new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url),
);

test("TypeScript contract fixes non-change-feed projections as reactive false", () => {
  const result = spawnSync(
    process.execPath,
    [tscPath, "--noEmit", "--project", "tsconfig.json"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: false,
    },
  );

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n") ||
      "TypeScript exited non-zero",
  );
});
