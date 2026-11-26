---
type: CI Performance Finding
title: "Finding 48: root script edits widened PR lanes to every package"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 48: root script edits widened PR lanes to every package

## Evidence

PR impact gate run 41882302284 failed in `Affected package lanes`. Its scope line reported `all (workspace-wide input changed: package.json)`, so build, typecheck, lint, unit, schema, and consumer-contract lanes ran in 796 packages. The sweep surfaced two pre-existing findings outside the PR diff: an unused import in `packages/cli/src/shell/errors.ts` and an unused Biome suppression in `packages/providers/provider-kubernetes/src/errors.ts`.

## Root cause

`scripts/ci/affected-lanes.mts` treated every root `package.json` and `turbo.json` path as a workspace-wide input. The PR changed root test scripts, root `//#` task entries, and `globalDependencies`. Workspace packages do not execute root scripts or root tasks, but `globalDependencies` files are hash inputs for every task. Path-only classification could not distinguish the root-only edits from the shared hash-input edit.

## Fix

The CLI now accepts `--base=<ref>`, resolves the merge base, and reads each root file from that commit and the working tree. JSON comparison keeps only scripts-only manifest edits and root `//#` task edits package-scoped. Other manifest or Turbo changes, including every `globalDependencies` addition or removal, remain workspace-wide. This PR's own `globalDependencies` removal therefore still runs the whole workspace once, by design. Missing readers, missing versions, and invalid JSON fail closed to workspace-wide behavior; omitting `--base` preserves the old behavior. PR, merge-group, main, and off-path workflow callers pass the same base used for their diffs.

## Pinning

`scripts/test/affected-lanes.test.ts` covers scripts-only filtering and skipping, dependency and environment widening, root and package task changes, `globalDependencies` additions and removals, missing or invalid base content, main-gate reader forwarding, and no-base CLI compatibility. The branch-shaped regression asserts workspace-wide scope for this PR's `globalDependencies` removal; the same scripts, root tasks, and package paths without that edit assert exactly the CLI and pricing filters.
