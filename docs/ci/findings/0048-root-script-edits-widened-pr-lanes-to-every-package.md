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

`scripts/ci/affected-lanes.mts` treated every root `package.json` and `turbo.json` path as a workspace-wide input. The PR changed only root test scripts, root `//#` task entries, and `globalDependencies`. Workspace packages do not execute root scripts or root tasks, and `globalDependencies` changes Turbo cache hashes rather than task behavior or environment. Path-only classification therefore widened lanes without a behavior-changing package input.

## Fix

The CLI now accepts `--base=<ref>`, resolves the merge base, and reads each root file from that commit and the working tree. JSON comparison keeps scripts-only manifest edits, root `//#` task edits, and `globalDependencies` edits package-scoped. Other manifest or Turbo changes remain workspace-wide. Missing readers, missing versions, and invalid JSON fail closed to workspace-wide behavior; omitting `--base` preserves the old behavior. PR, merge-group, main, and off-path workflow callers pass the same base used for their diffs.

## Pinning

`scripts/test/affected-lanes.test.ts` covers scripts-only filtering and skipping, dependency and environment widening, root and package task changes, hash-only dependency changes, missing or invalid base content, main-gate reader forwarding, and no-base CLI compatibility. A regression case combining this branch's root edits with `packages/cli` and `packages/pricing` paths asserts exactly those two package filters.
