---
type: CI Performance Finding
title: "Finding 169: state-machine verification ran on every change"
description: "The four state-machine-verification shards installed Java, Python and dependencies and built seven packages one at a time on every pull request and merge group, whatever the diff touched and even when a green pull-request run of the same tree was reused. The PR impact plan now decides whether the diff reaches the verification skills, merge groups reuse a green PR run, and the build runs at full concurrency."
tags: [hobo, ci, performance, merge-queue, state-machines]
---

# Finding 169: state-machine verification ran on every change

## Measurements

`state-machine-verification` in `hobo-ci.yml` is a four-shard matrix. Each shard held a runner for 5 to 7 minutes: checkout, Java and mise Python setup, the deps layer or an install, `turbo run build` of `@hobo/hobo`, `@hobo/dispatcher`, `@hobo/ci`, `@hobo/cd`, `@hobo/identity`, `@hobo/storage-sqlite` and `@hobo/runtime` at `--concurrency=1`, then `pnpm run verify:state-machines -- --shard=N/4`. Its condition had no relevance filter and no reuse skip, and `pr-gate` required `success`, so every pull request and every merge group paid four runner pickups and 20 to 28 runner-minutes for it. A merge group that reused a green pull-request run of the same tree (`pr-fabric-green`) skipped validation, workspace shards and scripts tests but still ran these four shards.

## Fix

- The PR impact plan's new step "Decide whether state-machine verification is needed" pipes `git diff --name-only BASE HEAD` (the PR merge commit's first parent, or the merge-group base after the proven-tree delta) into `scripts/ci/state-machine-scope.mts` and outputs `state_machines`. A missing or unreachable base, a script failure or any answer but `false` keeps it `true`.
- `state-machine-scope.mts` (node builtins only, reusing `job-scope.mts` and `affected-lanes.mts`) answers `false` only when no changed path reaches the verification: any `.agents/skills/verify-*` file, the verification and install scripts, `hobo-ci.yml`, `.github/actions/`, the action pins, the job-scope CI inputs, root workspace and toolchain inputs, workspace-wide inputs, files reached by relative import or named by a skill or reached shell script, and the manifest closure of the seven built packages and every package the skills name.
- The job needs `pr_gate_plan` and is skipped when the plan succeeded with `state_machines == 'false'`, or in a merge group when `pr-fabric-green` is `true`. `pr-gate` accepts a skipped result only for a successful route and plan with that output exactly `false`, or for the merge-group PR Fabric reuse, and still rejects failure, cancellation and an attestation alone.
- The build step uses `--concurrency=${HOBO_TURBO_BUILD_CONCURRENCY:-100%}`, as the scripts-tests shard build does since finding 166.

## Expected effect

Every merge group that reuses a green pull-request run saves four runner pickups and 20 to 28 runner-minutes. A pull request or merge group whose diff stays in docs, the site, unrelated workflows, other agent skills or scripts the skills do not reach skips the job after the plan. Over the last 100 merges to main, replaying each diff against today's tree, about 5% would have skipped on relevance alone; the closure of `@hobo/hobo` covers 108 workspace packages, so most package changes still verify. The build no longer serializes seven packages and their dependencies on a cold cache.

## Remaining limits

- The job is not covered by signed local runs: a local attestation would need Java and TLC 1.7.4, and a pull request whose plan was skipped for an attestation still runs it.
- A skill test that builds a path at run time without naming it, or reads a file through a computed import, is only covered when that file lies in a package or directory the skill names.

Whoever next updates `docs/ci/performance.md`, or the docs maintainer, regenerates the index with:

```sh
pnpm run docs:findings
```
