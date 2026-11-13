---
type: CI Performance Finding
title: "Finding 154: main waited for runners between jobs"
description: "On three green main runs the jobs did 4 to 5 minutes of work and waited another 2 to 7 minutes for runners between them; the tree had already passed in the merge queue each time."
tags: [hobo, ci, performance, main-gate, merge-queue, fleet, pickup, turbo, github-hosted]
---

# Finding 154: main waited for runners between jobs

## Evidence

Three consecutive green pushes to main on 2026-11-12. Times are from each job's `created_at`, `started_at` and `completed_at`.

| Run | Wall | Route | Deps layer: wait / run | Plan: wait / run | Full gate: wait / run | Finish: wait / run |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [43271789046](https://github.com/Hobo-Labs/HoBo/actions/runs/43271789046) | 9m58s | 13 s | 68 s / 106 s | 181 s / 18 s | 235 s / 191 s | 127 s / 30 s |
| [43261142301](https://github.com/Hobo-Labs/HoBo/actions/runs/43261142301) | 7m36s | 16 s | 127 s / 8 s | 154 s / 16 s | 247 s / 149 s | 29 s / 12 s |
| [43240626287](https://github.com/Hobo-Labs/HoBo/actions/runs/43240626287) | 18m02s | — | — | — | — | — |

The third run's jobs were not read for this finding. In the first two, no shard ran (the plan emitted `[]`).

1. **Deps, plan and gate queue at the same second and start one after another.** All three are created when the route job ends. The plan started 7 s and 19 s after the deps job finished, and the gate 36 s and 77 s after the plan finished. Each trunk job costs one runner arrival.
2. **Finish is twelve seconds of work behind a runner arrival.** It adds up three results and runs a two-second range scan.
3. **The deps job on an ARC pod pulled an image nothing reads.** In run 43271789046 it ran on `hobo-trunk-runner-ksd59` and spent 93 s in `Resolve local or GHCR deps image`. The pod's Docker context is not the box's, and job containers start from the box's `hobo-ci-deps:local`.
4. **The tree had already passed.** Each push's head commit is the commit its merge-queue run tested: `f0b586a1` is the head of merge-group run [43271000454](https://github.com/Hobo-Labs/HoBo/actions/runs/43271000454), `accb405b` of [43260399970](https://github.com/Hobo-Labs/HoBo/actions/runs/43260399970), `62dbc5d4` of [43273023189](https://github.com/Hobo-Labs/HoBo/actions/runs/43273023189). GitHub fast-forwards main to the merge group's commit, so Main full gate repeated that run's S0 and workspace lanes on an identical tree.
5. **The route job's verdict was not used.** Run 43271789046's route job logged `runner: ubuntu-24.04 (github): … in the last 60 minutes took up to 1376 s to pick a job up`. Every main job asked for `hobo-trunk` regardless.

## Cause

- Four trunk jobs where two do real work. `needs` edges were added one finding at a time ([92](./0092-main-plan-parallel-deps-affected-shards.md), [93](./0093-main-sub3m-plan-pickup-shards.md), [85](./0085-main-full-gate-workspace-shards-and-last-green-base.md)); each job is cheap and each handoff is not.
- Main never asked whether its tree had been tested. [Finding 12](./0012-main-re-ran-the-tests-its-own-pr-had-just-passed.md) made the repeat cheaper through the shared Turbo cache; the job, its runner arrival and its install still ran.
- Main jobs are pinned to the trunk label, including shards, which need nothing the box has.

## Fix

- **Main reuses the merge queue's result** (`scripts/ci/merge-queue-reuse.mts`, run by the route job). On a push to main it looks for a completed, successful `merge_group` run of this workflow, in this repository, on a `gh-readonly-queue/main/` branch, whose head is the pushed commit or has the pushed tree. When there is one, the route job's `merge-queue-green` output is `true`: **Main full gate** is skipped and the plan emits no shards. Anything short of that match, or a failed read, is `false` and main runs as before. Schedule and `workflow_dispatch` never reuse. The repository variable **`HOBO_CI_MAIN_REUSE_MERGE_QUEUE=false`** turns it off.
- **The deps layer check and the secret scan are steps of Main workspace plan.** `ci-deps-image` runs on pull requests only. The plan job promotes a verified image only on the box (`HOBO_CI_PNPM_STORE_MOUNTED=1`); elsewhere it leaves promotion to the daemon's ensure loop. The scan is the job's last step and has no condition, so a reused run still scans. The job's limit is 20 minutes, and the worker's own limit for it (`workflow-job-timeout.ts`) moves from 12 to 20 with it; a box daemon not yet restarted stops the job's container at 17.
- **Finish is GitHub-hosted and runs no repository code.** It adds up the gate, plan and shard results, and accepts a skipped gate only when `merge-queue-green` is `true`.
- **Main jobs follow the route.** This change routed the shards; [#1965](https://github.com/Hobo-Labs/HoBo/pull/1965) then routed the plan and the gate too and has the plan ask again before the shards (`shard_runner`), which is what the workflow carries now. The plan's deps layer steps run only on the box worker, so a run sent away from the fleet does nothing there, and the finish job stays GitHub-hosted.
- **A self-hosted Turborepo cache can be named.** `.github/actions/turbo-cache` takes `turbo-api` (the repository variable **`HOBO_CI_TURBO_API`**) and exports `TURBO_API` when a token and team are set. `packages/ci-gh-actions/deploy/turbo-cache/compose.yml` runs the open-source server, pinned by digest. Nothing uses it until the variable, `TURBO_TEAM` and the `TURBO_TOKEN` secret are set.

A reused main run is the route job (GitHub-hosted), one trunk job (plan, about 20 s of work) and finish (GitHub-hosted): one runner arrival where there were four.

## What reuse gives up

- **Generated-output drift** (`codegen:check:affected`) runs only in Main full gate, so a reused push does not run it. The daily schedule does.
- **Main's cache seeding.** The gate's `actions/cache` saves (Turbo fallback, pnpm store) feed GitHub-hosted pull request runs; a reused push does not refresh them. Box jobs share the host directory and are unaffected.
- **A wider last-green range.** Main tests from the last green main commit; a merge group tests from its base. With reuse, a green main run means "the merge queue passed this tree", so the two ranges are the same commits.

## Not changed

- **Warm runners.** The box's spare container is off whenever a work root is set, which production always sets ([finding 62](./0062-memory-reservations-were-guesses-held-as-hard-limits.md)): a job's work directory is bind-mounted at container creation under its lease id, so a container cannot be created before its job is known. Keeping a listener registered ahead of a job needs a lease with no job in the controller and reconciler. ARC's trunk scale set starts pods on demand (`minRunners` is not in this repository). Neither is changed here.
- **The shard reservation.** A shard still reserves 4096 MiB on the box. Routing sends shards elsewhere when the fleet is not taking jobs; it does not make the box admit them sooner.
- **Capacity-aware routing.** Main's jobs follow the route job, which reads the queue and asks the relay for its fleet verdict ([#1952](https://github.com/Hobo-Labs/HoBo/pull/1952), [ADR-0180](../../design/adr/fleet-verdict.md#adr-0180)); nothing about the fleet is passed in through a variable.
- **The deps image key** already hashes the lockfile, workspace file, manifests, patches, platform and toolchain ([finding 60](./0060-the-deps-key-rebuilt-on-recipe-churn.md)). The 42 s install in Main full gate was on ARC pods, which mount no deps layer.
- **The route job** stays a separate GitHub-hosted job: required pull request checks and the image job hang off it.

## Measure

On the next pushes to main after this lands:

- The route job logs `merge-queue reuse: yes: the merge queue passed this commit (run …)`; **Main full gate** shows `skipped`; **Main full gate (finish)** runs on `ubuntu-24.04` and starts within seconds of the plan job ending.
- Wall time is route + one trunk pickup + about 30 s. With the pickups measured above (68 to 127 s) that is 2 to 3 minutes.
- A push that did not come through the queue logs `merge-queue reuse: no: no merge-queue run for this tree` and runs the gate.

## Verified

- `scripts/test/merge-queue-reuse.test.ts` — the decision (commit, tree, kill switch, events, every refused run shape) and the run lookup.
- `scripts/test/main-plan-merge-queue-reuse.test.ts` — the planner emits an empty plan on reuse with no git, turbo or network.
- `scripts/test/main-gate-finish.test.ts` — the finish script over result combinations, including a skipped gate with and without reuse.
- `scripts/test/main-gate-workspace-shards.test.ts`, `scripts/test/ci-deps-image-contract.test.ts`, `scripts/test/gitleaks-main-scan.test.ts`, `scripts/test/turbo-cache-action.test.ts`, `packages/ci-gh-actions/test/deps-image-scope.test.ts`, `packages/ci-gh-actions/test/main-gate-image-wait.test.ts` — the workflow shape.
- `node --import tsx scripts/lint-actions.ts`.
- Not verified: no run of the changed workflow on GitHub yet. The route step's reuse lookup, the plan job's box check and a shard on a GitHub-hosted machine have not run for real. The cache server compose file was parsed, not started.
