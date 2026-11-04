---
type: CI Performance Finding
title: "Finding 3: the turbo cache never saved on main"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 3: the turbo cache never saved on main

`.github/actions/turbo-cache` used the combined `actions/cache`, which saves only in its post step and only
when the job succeeds. Main full gate always failed, so main never saved; every run logged `Cache not
found` and rebuilt everything. No `TURBO_TOKEN` is configured, so there is no remote cache either.

Fixes: [#1642](https://github.com/Hobo-Labs/HoBo/pull/1642) restores at job start and saves in an
`if: always()` step, pruned to the hashes the job's run summaries touched. Turbo caches only successful
tasks, so a partial save is correct. Pushes to main seed it; PRs and merge groups restore it. Test results
reach it only after finding 2's `test:unit` death is fixed and "Full workspace tests" runs.

Two follow-ups, measured on main. The prune kept only the entries the job's own runs touched, and main's
runs are affected-only, so each save shrank the cache to a handful of packages and the next run built the
rest cold: run 41587620284 (7m16s, green) spent about 60 s of its 4m56s "Workspace tests" on cold
builds. And run 41580946041's "Save Turbo cache" took 2m00s, all of it `Getting action download info`
for the composite's `actions/cache/save` timing out (100 s) and retrying; the save itself took a
second. `scripts/ci/turbo-cache-prune.mts` now keeps entries used within 7 days, and runs as a workflow
step that outputs `save=false` when no task missed the cache, so a fully cached run skips the save step
and never resolves the action.

Main's workspace tests are now scoped with `--filter=...[<previous main commit>]` (changed packages plus
their dependents). A git-based filter sees only files git attributes to a package, so
`scripts/ci/affected-lanes.mts` decides first: a workspace-wide input (workspace, turbo,
tsconfig, biome, toolchain pins) or an unreachable base runs the whole workspace instead; `pnpm-lock.yaml`
alone does too, but a lockfile edit together with changed package paths only runs those packages (Turbo
still hashes the lockfile). The PR impact gate uses the same script.

Where a test task does run, `@hobo/hobo#test` dominates. In an affected sweep for a four-package change it
took 181 s of 332 s task time (87 tasks).

**Dependents run only the test files that can see the change.** A package filter is still too coarse:
`@hobo/hobo` depends on `@hobo/ci-gh-actions`, so every worker-daemon or poller edit ran all ~200 s of
hobo's suite, though hobo imports only four of ci-gh-actions' entry points and none of them reaches the
worker. `scripts/ci/dependent-tests.mts` now plans main's Workspace tests: packages with a changed file
run whole through turbo, and each dependent runs only the test files whose import closure reaches a
changed file. The walk follows imports, `resolve()` calls and path literals file by file, crosses
packages through each manifest's `exports` (so `@hobo/ci-gh-actions/client` is `src/client.ts`, not the
package), and reads a `dist/` path as the `src/` file built into it, which is how hobo's tests reach
the CLI they spawn. A literal naming another package's file, such as `hobo ci serve --with-worker`
spawning the daemon, is that one file: the daemon runs as its own process and ci-gh-actions' suite
covers what it imports. It gives up, and runs the test, on a computed `import()` in a test or a relative
import it cannot resolve; a dependent whose `test` script is more than `vitest run`, or whose vitest
config reaches the change, runs whole. For a change to ci-gh-actions' `src/hosted-relay.ts`, hobo now
runs 1 of its 111 test files (`cloudflare-worker-routes`, through its computed import; `e2e/ci.test.ts`
imports the relay too but hobo's vitest config excludes `e2e/`) and `examples/self-host-yard` is
skipped; `src/isolated-worker/github-job-poller.ts` gives the same. `src/client.ts` still runs most of
hobo, because hobo's CLI entry imports it. `scripts/test/dependent-tests.test.ts` pins
the rules on an in-memory tree.

The first version ran each dependent's file subset as `turbo run build` and then `vitest run` in the
package, which bypassed turbo's `test` task. A package's `<pkg>#test` `dependsOn` lists builds its
tests need beyond its own dependencies: `@hobo/hobo#test` adds `@hobo/adapter-hono#build`, because
`examples/hello-bindle` imports it at test time. That build never ran on the main path, and main runs
41616466379 and 41618937951 failed 13 hobo tests with `Failed to resolve entry for package
"@hobo/adapter-hono"`. PR runs passed because the impact gate calls `turbo run test`.

The second version (#1664) ran each subset as `turbo run test --filter=./<dir> -- <files>`. Turbo
hands `--` arguments to every task of a run, dependency builds included, and hashes them in. Main run
41632724009 (754 s) therefore rebuilt about 80 packages uncached for each of six subsets: Workspace
tests took 8 minutes, `@hobo/code`'s subset 2m10s and `@hobo/hobo`'s 3m01s around 75 s of vitest.

Now the planner reads turbo's own graph (`turbo run test --filter=… --dry=json`) once and makes one
call with those task ids and no pass-through. That call runs the whole suites and every build the
subsets' test tasks depend on, the `<pkg>#test` overrides included, with the same hashes as a plain
`turbo run test`, so it shares the cache. Then each subset runs its test task alone:
`turbo run test --filter=./<dir> --only -- --passWithNoTests <files>`. Replaying #1664's diff locally
gives one 86-task build call and six subset calls, 120 s in all at `--concurrency=1`. The planner test
pins the command shape on a fake graph, and checks against the real graph that `@hobo/hobo`'s subset
gets `@hobo/adapter-hono#build` in the build call.

**hobo's own suite runs its process-bound cases concurrently.** Four files held 133 s of the suite's
177 s of test time, each case starting `hobo` or a composed binary and waiting on it:
`starter-deployment-end-to-end` (53.6 s), `persistent-local-deployment` (38.5 s), `bin-opensesame`
(24.6 s) and `composed-temp-dirs` (16.6 s). Their cases already used separate projects, `HOBO_HOME`s
and OS-assigned ports; the last two shared module-level directories set in `beforeEach`, now made per
test and removed with `onTestFinished`. All four are `describe.concurrent`, with the test context's
`expect`. Measured on a four-core VM with `CI=1` (two workers): the four files take 21 s, 15 s, 10 s
and 6 s alone, and the whole suite went from 145 s to 116–120 s wall, test time from 177 s to 117 s.
What remained was mostly import. hobo's config set `isolate: true` for every file, so each of 111
files composed the CLI again, about 105 s of worker time. In main run 41606568492 (204 s), that suite
took 123 s of the 142 s S0 step. Isolation only matters for a file that changes process-wide state.
Seven do: they set `process.env` or `globalThis.fetch` and restore it afterwards. None of the other
104 uses a mock, spy, fake timer, stubbed global or `process.on`. The config now runs two vitest
projects:
- `isolated` holds the seven files listed in `test/support/isolated-test-files.ts`, each with its
  own module graph as before.
- `shared` holds everything else, with `isolate: false`.

`test/isolated-test-files.test.ts` fails if a test file starts changing that state without being
listed, or stays listed after it stops. The shared set passed three shuffled orders (seeds 11, 222 and
3333). On a four-core VM with `CI=1` (two workers), the suite went from 130 s to 76 s wall, and import
time from 104 s to 24 s.

The first PR run of that change (41611916800) was OOM-killed (exit 137) in the 6 GiB job container.
Sampling the run's process tree (proportional set size) and the pod's `anon + shmem` from
`memory.stat` shows where the memory went. The vitest process, with both worker threads, peaked at
about 1.4 GB, only about 0.1 GB more than with `isolate: true`. The rest was CLI children: each
concurrent case in the four suites above spawns one of about 450 MB (tsx from source, `codegen`, a
served `up`), and at vitest's default `maxConcurrency` of 5 per worker about 14 were alive at once.
Peak anon was 5.71 GB with main's config and 5.93 GB with the shared projects. Both leave less than
the runner's own processes need under the 6.44 GB limit. hobo's config now sets `maxConcurrency: 2`.
The `--maxConcurrency` CLI flag does not reach `projects`, so it has to be set in the config. With that
setting, peak anon falls to 3.58 GB (about 4 children) and wall stays at 78 s, because the cases wait
on their child, not on the CPU.
