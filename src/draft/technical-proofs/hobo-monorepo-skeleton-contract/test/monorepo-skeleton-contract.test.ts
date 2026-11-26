import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canonicalSkeleton,
  detectWorkspaceCycles,
  validateBoundaryImports,
  validateMonorepoSkeleton,
} from "../src/monorepo-skeleton-contract.js";

test("canonical monorepo skeleton satisfies the HOBO-1 package and script contract", () => {
  const result = validateMonorepoSkeleton(canonicalSkeleton);

  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.packageManager, "pnpm");
  assert.ok(result.summary.requiredPackages.includes("packages/core"));
  assert.ok(result.summary.requiredPackages.includes("examples/hello-bindle"));
  assert.equal(result.summary.requiredScripts.join(","), "build,typecheck,lint,test");
  assert.equal(canonicalSkeleton.workspace.release.changesetsRequired, true);
  assert.equal(canonicalSkeleton.workspace.release.conventionalCommitsRequired, true);
});

test("boundary lint fails a deliberate cross-adapter import fixture", () => {
  const result = validateBoundaryImports(canonicalSkeleton.imports, [
    { from: "packages/providers/provider-aws", to: "packages/providers/provider-azure" },
  ]);

  assert.match(result.errors.join("\n"), /adapters must not import each other/);
});

test("cycle check rejects circular workspace dependencies", () => {
  const result = detectWorkspaceCycles([
    { from: "packages/cli", to: "packages/runtime" },
    { from: "packages/runtime", to: "packages/cli" },
  ]);

  assert.deepEqual(result.errors, [
    "workspace dependency cycle: packages/cli -> packages/runtime -> packages/cli",
  ]);
});
