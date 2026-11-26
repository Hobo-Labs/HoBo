#!/usr/bin/env node

import {
  canonicalSkeleton,
  detectWorkspaceCycles,
  validateBoundaryImports,
  validateMonorepoSkeleton,
} from "../src/monorepo-skeleton-contract.js";

const mode = process.argv[2] ?? "build";

const checks = {
  build: () => validateMonorepoSkeleton(canonicalSkeleton),
  typecheck: () => validateMonorepoSkeleton(canonicalSkeleton),
  lint: () => ({
    errors: [
      ...validateBoundaryImports(canonicalSkeleton.imports).errors,
      ...detectWorkspaceCycles(canonicalSkeleton.imports).errors,
    ],
  }),
};

const runCheck = checks[mode];

if (!runCheck) {
  console.error(`unknown verifier mode: ${mode}`);
  process.exit(2);
}

const result = runCheck();

if (result.errors.length > 0) {
  console.error(result.errors.join("\n"));
  process.exit(1);
}

console.log(`hobo-monorepo-skeleton ${mode}: ok`);
