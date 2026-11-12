---
type: CI Performance Finding
title: "Finding 144: no pull-request job ran the scripts lane"
description: "pnpm run test:scripts, the lane that runs every test under scripts/test, was run by no workflow, so three stale expectations and a broken script test reached main on green pull requests; the lane is now the required job scripts-tests."
tags: [hobo, ci, scripts, pr-gate, tests, required-check]
---

# Finding 144: no pull-request job ran the scripts lane

## Evidence

[#1943](https://github.com/Hobo-Labs/HoBo/pull/1943) merged with `scripts/test/main-gate-workspace-shards.test.ts` failing, on a green **PR impact gate**. No job in `.github/workflows/hobo-ci.yml` ran `pnpm run test:scripts` (`scripts/run-tests.ts --category=scripts`).

On `claude/relay-fleet-verdict` (`d805016b`), in a clean container, the lane failed 8 tests in six suites:

| Suite › test | Node 22.23 | Node 24.22 (the pinned toolchain) |
| --- | --- | --- |
| *workspace test shards on this repository* › carries every workspace turbo would test in exactly one shard | fail | pass |
| *planCommands* › the build-once call carries `@hobo/hobo#test`'s extra dependsOn | fail | pass |
| *turbo unit tasks cover the old runner and every root shard input* | fail | pass |
| *workspace test duration balancing* › spreads measured slow workspaces across main shards | fail | pass |
| *the repository's own plans* › runs the suites whose config reaches `vitest.config.ts`, `test/setup/hobo-test-homes.ts`, `test/setup/isolate-hobo-home.ts` (3 tests) | fail | fail |
| *main workspace affected-only* › intersects import-walk plans with turbo `--affected` before main sharding | fail | fail |

## Cause

1. **Nothing ran the lane.** `pr_gate_validation` runs `pnpm agent:check`, whose root-test check is `test:root` (`test/*.test.ts` only). `scripts/test` ran only when someone ran it by hand.
2. **Three expectations went stale unseen.** `packages/secret-store-claim` ([#1921](https://github.com/Hobo-Labs/HoBo/pull/1921)) and `src/draft/technical-proofs/hobo-auth-authoring-surface` ([#1939](https://github.com/Hobo-Labs/HoBo/pull/1939)) began merging the root `vitest.config.ts`; the planner rightly reached them and the list in `scripts/test/dependent-tests.test.ts` did not.
3. **One assertion read a message the workflow removed.** [#1938](https://github.com/Hobo-Labs/HoBo/pull/1938) (finding 139) replaced the finish job's `plan did not emit shards=[]` branch with an early pass on an empty plan; `scripts/test/main-workspace-affected.test.ts` still looked for the old text.
4. **The four turbo failures are the container's Node, not the code.** `mise.toml` pins Node 24. Under Node 22 `pnpm exec turbo` prints pnpm's `Unsupported engine: wanted: {"node":"24.x"}` warning for `packages/ci-vercel` on stdout ahead of turbo's JSON, and `turboTestGraph` (`scripts/ci/dependent-tests.mts`) cannot parse it. The fleet image carries Node 24, and `ci-runner-preflight` installs the pinned toolchain from `mise.toml` on a GitHub-hosted machine, so the job never runs under Node 22. Under `mise exec -- pnpm run test:scripts` (Node 24.22.2) all four pass.
5. **One Vitest file needs built packages.** `scripts/test/hosting-anonymous-acceptance.test.ts` imports `scripts/manual/hosting-anonymous-acceptance.mts`, which imports `packages/hobo/src` and six providers' `src/`; their own imports (`@hobo/core`, `@hobo/kv-redis-compatible`, …) resolve through `dist/`. A fresh checkout has no `dist/`, so on Node 24 the lane exits 1 with `Failed to resolve entry for package "@hobo/core"`. The first version of the job built nothing and passed only where an earlier run had left `dist/` behind.
6. **One workflow set the heap by hand.** Restacked on `claude/relay-fleet-verdict` (`dbff25e88`), the lane failed *job memory environment* › *sizes workers, heap, and turbo from a 4647 MiB job*: `.github/workflows/fleet-enrollment.yml` ([#1688](https://github.com/Hobo-Labs/HoBo/pull/1688)) set `NODE_OPTIONS: --max-old-space-size=3072` at workflow level, and `scripts/test/memory-env.test.ts` forbids `NODE_OPTIONS` in every workflow: the heap cap is set where the job's memory is known (the fleet worker injects `NODE_OPTIONS` at container creation, and `ci-runner-preflight` writes the job's sizing).

## Fix

- The two test expectations follow the code they describe: the suites that merge the root config, and the finish job's empty-plan pass.
- `fleet-enrollment.yml` no longer sets `NODE_OPTIONS`; both of its jobs run `ci-runner-preflight` on the fleet, which sizes the heap from the job's memory.
- **The job `scripts-tests`** in `hobo-ci.yml` runs `pnpm run test:scripts` on pull requests and merge groups when the change touches `scripts/**`, `test/**` or `.github/**`, on the routed runner after `ci-runner-preflight`. Before the lane it restores the Turbo cache and builds the dependencies (`--filter=<package>^...`) of every package whose `src/` a scripts test imports, 88 build tasks. The **PR impact gate** needs it and fails unless it succeeded.
- **`scripts/relevant-check-policy.ts`** selects `test:scripts` for the same paths in a base-ref `pnpm agent:check`, and leaves it to the job when the caller runs workspace tests externally (CI) or checks a staged commit.

## Measure

- A pull request that breaks one test under `scripts/test` shows **Scripts tests** red and the **PR impact gate** red.
- `pnpm run test:scripts` exits 0 on the CI runner image.

## Verified

- `test/relevant-check-policy.test.ts` — *a change to scripts, root tests or .github selects the scripts lane once*; *the scripts lane is not selected for other paths, a staged commit, or CI* (both fail on the previous policy).
- `scripts/test/scripts-tests-job.test.ts` — *the scripts lane is a pull-request gate*: the job's runner, events and step order; *builds what every package a scripts test imports depends on, before the lane*, which walks the scripts tests' relative imports and fails if the build step misses a package (fails before the build step existed); its scope step run in temporary repositories (a merge group, a pull request's merge commit, no base); and the gate's step run for every scripts-job result, with the other jobs passing and with them attested (fails before the job existed).
- `pnpm run actions:lint`: the job needs `route` and uses the routed `runs-on` expression.
- In a fresh worktree with no `dist/` (Node 24.22.2, the toolchain `ci-runner-preflight` installs), `pnpm run test:scripts` alone exits 1 on cause 5. After the job's build step, it exits 0: 1347 node:test tests pass, 1 skipped; 34 Vitest files, 327 tests pass, 12 skipped. Under Node 22.23.4 the four turbo tests of cause 4 also fail.

## Not yet seen

- The job on a pull request, and a pull request that breaks one script test showing it red: this change was not run on GitHub.
