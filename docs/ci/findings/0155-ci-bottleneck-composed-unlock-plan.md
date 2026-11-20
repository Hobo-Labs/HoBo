---
type: CI Performance Finding
title: "Finding 155: CI bottleneck composed unlock plan"
description: "Over the last 15 merge-group Fabric runs (2026-11-20) the wall averaged 15.98 min and was the serial sum of PR impact validation plus the slowest workspace shard plus ~25 s; the deps publisher still holds a box slot 5.69 min per green main, and 6 of 13 relay deploys failed adopting a Vercel Git deployment a project that is intentionally not Git-linked never creates. A composed fix per target, designed to compose."
tags: [hobo, ci, performance, merge-queue, fabric, shards, turbo-cache, deps-publisher, relay-deploy, vercel]
---

# Finding 155: CI bottleneck composed unlock plan

Design finding (step A): evidence and a composed plan. Nothing here is implemented in this change.

## Evidence

gh api measurements from 2026-11-20 over the last 15 merge-group **HoBo CI Fabric** runs (`fabric_runs`, plus `tyler_page_baseline` from Tyler's dashboard). Seconds are job step timings; walls are workflow wall time.

| Fabric run | Wall | PR impact validation | Slowest shard | Sum vs wall |
| --- | ---: | ---: | ---: | ---: |
| [44667985721](https://github.com/Hobo-Labs/HoBo/actions/runs/44667985721) | 27m00s | 13m06s | shard 1: 13m29s | 1595 s vs 1620 s |
| [44656082290](https://github.com/Hobo-Labs/HoBo/actions/runs/44656082290) | 19m59s | 8m59s | shard 1: 10m37s | 1176 s vs 1199 s |
| [44695856191](https://github.com/Hobo-Labs/HoBo/actions/runs/44695856191) | 20m39s | 8m38s | shard 1: 11m30s | 1208 s vs 1239 s |
| [44669166979](https://github.com/Hobo-Labs/HoBo/actions/runs/44669166979) | 20m19s | 8m53s | shard 1: 11m05s | 1198 s vs 1219 s |
| [44669699350](https://github.com/Hobo-Labs/HoBo/actions/runs/44669699350) | 10m18s | 2m24s | shard 1: 7m10s | — |

1. **The merge-group wall is a serial sum.** `workspace_tests` needs `pr_gate_validation`, and the runner pickup between them is small: wall ≈ PR impact validation + slowest shard + 21–31 s on the four summed runs above. Nothing else (scripts tests 4×~25–30 s, route ~15 s) is on the critical path.
2. **PR impact validation is bimodal on cache.** 4 of 15 runs took 8m38s–13m06s (518–786 s); the warm band is 1m07s–2m53s (67–173 s); average 4m11s. Tyler's baselines: PR-impact cache hit **6.1 %**, Turbo cache hit **36 %**. The four cold runs produced the four slowest walls (19m59s–27m00s).
3. **Shard skew outlives the planner.** Slowest shard is Workspace test shard 1 in 11 of 15 runs, averaging **8.74 min** vs **6.42 min** for the second (gap **2.32 min**); its per-run range is 3m37s–13m29s. The duration table `scripts/ci/workspace-test-durations.json` (measured 2026-11-11, source run 42951579615) prices `packages/hobo` at **113 s** — 4–7× below what the shard carrying it measures. On affected-only merges with few planned shards the heavy load lands on shard 0 instead (823 s in [44691451547](https://github.com/Hobo-Labs/HoBo/actions/runs/44691451547), 674 s in [44674421872](https://github.com/Hobo-Labs/HoBo/actions/runs/44674421872)).
4. **Concurrency is pinned to 1 everywhere.** Workflow env `HOBO_TURBO_CONCURRENCY: "1"` and `HOBO_TEST_MAX_WORKERS: "1"` (`.github/workflows/hobo-ci.yml`), the S0 gate set runs `HOBO_RELEVANT_CHECK_CONCURRENCY: "1"`, and each workspace shard exports `HOBO_TURBO_CONCURRENCY: "1"` into the test step. The remote cache is configured only if `TURBO_TOKEN`/`TURBO_TEAM` are set; the committed fleet cache server is unnamed (`turboCache.api` is `""` in `.hobo/ci.json`), so GitHub-hosted and ARC shards fall back to `actions/cache` with `preferred-job`.
5. **Deps publisher.** Measured average **5.69 min** per green main run (Tyler baseline 15.9 min before findings 151–153 landed). `ci-deps-publish.yml` runs `publish` on the self-hosted `hobo` label, after `needs: [runner-image]`, so a missing worker image serializes the publisher behind a multi-minute build before its own work; the box has 2 slots and 1 merge-group lease (`.hobo/ci.json` `runnerRouting.box`).
6. **Relay deploy fails adopting a deployment that is never created.** 6 of the last 13 relay runs failed: [44657835685](https://github.com/Hobo-Labs/HoBo/actions/runs/44657835685), [44658506027](https://github.com/Hobo-Labs/HoBo/actions/runs/44658506027), [44671409500](https://github.com/Hobo-Labs/HoBo/actions/runs/44671409500), [44683823325](https://github.com/Hobo-Labs/HoBo/actions/runs/44683823325), [44688180710](https://github.com/Hobo-Labs/HoBo/actions/runs/44688180710), [44693355799](https://github.com/Hobo-Labs/HoBo/actions/runs/44693355799). `relay-deploy.yml` deploys through `hobo ci deploy --adopt`, which waits (bounded by the gate's deadline, up to ~14 min) for the Vercel **Git** deployment of the pushed commit to appear through GitHub's Deployments API. The relay's Vercel project is intentionally **not** Git-linked, so that deployment never appears; the command ends in the `HOBO_CI_ADOPT_NOT_FOUND` / `HOBO_CI_ADOPT_NOT_READY_IN_BUDGET` family and production keeps serving the previous commit until a human intervenes. The adopt step's `set -uo pipefail` (no `-e`) with `|| true` on the summary print then leaves a bare exit code when the command died without writing JSON, so the run page often shows less than the typed reason it ended with. `adopt_seconds` is null across all 13 runs: no per-run adopt timing was captured at all.

## Target 1: merge-group Fabric wall (avg 15.98 min, worst 27 min)

[#2914](https://github.com/Hobo-Labs/HoBo/pull/2914) (in the merge queue) adds vitest **file sharding** for `@hobo/hobo` and the planner changes around it. This target is what remains **after** it merges.

### Candidates

1. **Duration-based shard rebalance.** Refresh `workspace-test-durations.json` from measured runs automatically — a post-green-main step that rewrites the table from the run's own Turbo summaries (`TURBO_RUN_SUMMARY` already writes `.turbo/runs/<id>.json`; `ci-trace` turns them into spans) — and extend the weights to per-file seconds for file-sharded suites. `planUnitLoadSeconds` (`scripts/ci/dependent-tests.mts`) already prorates subsets per test file, so file-level weights slot into the existing partition; the planner's doubt behavior (all eight shards on any odd answer) is unchanged.
   *Tradeoffs:* the table becomes generated data needing a refresh lane; a stale table silently re-skews (today's 113 s for `packages/hobo` is the evidence). Fail-open `defaultSeconds` stays.
   *Expected saving:* the 2.32 min slowest-vs-second gap to under ~1 min — **1.5–2.3 min** off the wall (~10–14 %), more on runs where shard 0 absorbs a whole affected set.
2. **Remote Turbo cache for merge-group runs.** Name the committed cache server: set `turboCache.api` in `.hobo/ci.json` to the self-hosted server from finding 154 (compose file pinned by digest in `packages/ci-gh-actions/deploy/turbo-cache/`), keeping `TURBO_TOKEN`/`TURBO_TEAM` as the Vercel-cache alternative the `turbo-cache` action already supports. Merge-group S0 and shards then replay what the PR run of the same tree built, on the box, on ARC pods and on GitHub-hosted runners alike (the box's shared host-directory local cache covers only box jobs).
   *Tradeoffs:* one more service with uptime and pruning (`turbo-cache-prune.mts` exists); forks stay read-only/off; a cache server is shared infrastructure, so a restart storm can turn hits into misses — the bimodal S0 evidence makes even partial hits worthwhile.
   *Expected saving:* cold S0 runs (518–786 s, 4 of 15) fall to the warm band (67–173 s): **6–10 min** off cold-tail walls; **2–4 min** off the average (4m11s → ~2 min). This is the single largest lever in the data.
3. **Safe `HOBO_TURBO_CONCURRENCY` > 1 where memory allows.** Replace the workflow-wide `"1"` with a per-shard value derived from the runner's cgroup limit by `ci-runner-preflight` (it already computes memory env), capped per runner tier, failing closed to 1. Finding 140 is the failure mode being avoided: four Vitest forks with 3 GiB heaps plus componentize-js wizer exceed a 6 GiB job container. So: 1 on the box's 6 GiB job containers, 2 only on tiers with headroom (GitHub-hosted 7 GiB / larger ARC pods), and `HOBO_TEST_MAX_WORKERS` follows the same derivation.
   *Tradeoffs:* memory contention is a real past incident, not hypothetical; the raise must be cgroup-derived, per-shard and reversible, never a blanket env bump. Shard-on-shard interference on the box (two slots) argues for keeping 1 there.
   *Expected saving:* the slowest shard's suites run ~2-wide where allowed — up to **30–40 %** off that shard (**2.5–3.5 min**); zero where it stays 1.
4. **Start shards before S0 ends.** Emit the shard plan mid-`pr_gate_validation` (it is computed before the S0 gate set step) and let shards begin checkout/deps-link in parallel, gating only their test step on validation success.
   *Tradeoffs:* a failing S0 wastes shard-minutes and box slots precisely when the queue is busy; the `needs` edge is also the required-check contract. **Rejected**: strictly weaker than 1–3 for more contract churn.

### Picked

1 + 2 + 3, in that order. They attack three different terms of the same serial sum — S0 cold misses, shard skew, shard serialization — and none invalidates another: the rebalance plans against measured durations whatever shard count the file sharding produces; the cache shortens every term including the rebalance's own measurement source; concurrency multiplies whatever each shard still has to run.

## Target 2: CI deps image publisher (avg 5.69 min of box occupancy per green main)

### Candidates

1. **GitHub-hosted existence fast path.** A ~1-minute `ubuntu-24.04` job (workflow_run) runs `docker manifest inspect` (or the registry API with `GITHUB_TOKEN`) for `ghcr.io/<repo>/hobo-ci-deps:<key>` before any box job starts; `publish` and `runner-image` run only on a miss. Most green main pushes touch no image input, and `publish-deps.sh` already exits 0 on an existing manifest — it just discovers that after a box checkout.
   *Tradeoffs:* one extra hop (~30–60 s) on a non-blocking path; needs `packages: read` on the fast-path job.
   *Expected saving:* most runs drop from 5.69 min of `hobo`-label occupancy to ~1 min GitHub-hosted — freeing one of the box's 2 slots for merge-group shards, which is Target 1's capacity.
2. **Decouple `publish` from `runner-image`.** The `needs: [runner-image]` edge exists because the deps key embeds the worker image key; gate on it only when the worker key actually changed (both keys are computable from the commit without Docker). Otherwise `publish` starts immediately.
   *Tradeoffs:* the staging-registry race the comment describes (two `build.sh` on the box's fixed staging registry) must be re-checked; the concurrency groups stay.
   *Expected saving:* removes the worker-image build (multi-minute when GHCR lacks it) from the publisher's critical chain — up to ~5 min off the runs that currently serialize.
3. **Push, don't rebuild.** When the green Fabric run already built `hobo-ci-deps:<key>` on the box (the CI deps layer job), publish tags and pushes that image instead of running `wait-deps-build-window` + `build-deps.sh`; the keyed label check (`hobo.ci.deps-key`) `publish-deps.sh` already performs for the `:local` candidate is the same integrity gate.
   *Tradeoffs:* the image must come from the same commit's green run, never a PR-built cache tag — the worker-image job already refuses the box's Docker cache for exactly that reason (finding 113), and this must hold the same line. Needs the merge run's keyed image to still be on the box (or exported) when the publisher starts.
   *Expected saving:* the build case (the multi-minute tail of the 5.69 min average) shrinks to tag + layer-delta push, **~2–4 min** off those runs.
4. **Move the publisher off the box entirely.** ARC or GitHub-hosted with `buildx` + `--cache-from` the GHCR buildcache. Frees the box unconditionally but loses the box's Docker layer cache, and finding 143 showed the runners lack buildx unless images change. **Rejected** as slower to ship than 1–3 for less gain.

### Picked

1 + 2 first (no trust-surface change, workflow-shape only), then 3 for the build case. Together: typical green main costs ~1 min of GitHub-hosted time and zero box slots; the rare image-input change still builds once, pushes twice.

## Target 3: relay deploy must stop adopting and deploy the commit itself

### Candidates

1. **HoBo CD deploys the commit itself.** Replace `hobo ci deploy --adopt` in `relay-deploy.yml` with the direct deploy path: HoBo CD creates and promotes the Vercel deployment for the pushed commit through the Vercel deploy API, using the deploy credential the relay's secret store already holds — `ci-relay-deploy-credential.ts` reads `VERCEL_TOKEN` from the store with the job's GitHub OIDC token, and the token lives in CD's trusted vault for the request, never in an env var, a file, or a log. Fail-closed verification stays exactly as it is (`ci-relay-verify.ts`): preview READY for this commit, production `/healthz` names the commit, `/readyz` answers 200; a failed production verification is recorded in the CD journal and reported by reason, never silently rolled back.
   *Tradeoffs:* the job changes from observer to actor — the workflow comment's "deploys nothing and holds no Vercel token" becomes "deploys through HoBo CD, holding no token in GitHub" (the store binding and OIDC exchange it already performs are unchanged). The deadline-split budget machinery carries over from the adopt path.
   *Expected saving:* not minutes — **reliability**: deploys converge in one run instead of 6 of 13 waiting out a budget for a Git deployment that is never created, and production stops lagging main behind manual re-runs.
2. **Fail loudly.** Whichever verb runs: the step keeps explicit status capture but the report may not `|| true` — a missing or unparsable result JSON fails the report step, and the typed refusal code plus the command's stderr go to the step summary and an annotation. Capture per-run deploy timing (the `adopt_seconds: null` column is the gap that made this target hard to see).
   *Tradeoffs:* none of substance; slightly noisier failures are the point.
3. **Keep adopt, retry harder.** Waiting longer or re-running for a deployment that requires a Git link the project must never have. **Rejected** — the wait is the bug.
4. **Human-run deploys only.** **Rejected** — HoBo owns deployment through HoBo CD; the workflow is the owner's hands.

### Picked

1 + 2, as one change: the same PR that switches the verb makes its failures legible.

## Composed plan

| Order | Change | Target | Type |
| --- | --- | --- | --- |
| 1 | HoBo CD deploys the commit itself + fail-loud reporting | 3 | code + workflow |
| 2 | Name the fleet Turbo cache server (`turboCache.api`) | 1 | config |
| 3 | Duration-table auto-refresh + per-file weights (after #2914 merges) | 1 | code |
| 4 | Cgroup-derived per-shard `HOBO_TURBO_CONCURRENCY`, fail-closed to 1 | 1 | workflow + preflight |
| 5 | Deps publisher GitHub-hosted fast path + decouple from `runner-image` | 2 | workflow |
| 6 | Push-don't-rebuild for the deps build case | 2 | script |

Ordering rationale: Target 3 goes first because production is failing **now** (6 of 13) while Targets 1–2 are latency; Target 1.2 is config-only and immediately shortens the cold-tail walls that dominate the average; Target 1.3 waits for #2914 so it rebalances against the file-sharded shape rather than the package shape it would replace; Target 2 lands last because its benefit partly depends on how much shard pressure remains after 1.

The targets compose instead of fighting: Target 1's balanced shards want box slots exactly when Target 2 stops spending them on the publisher; Target 1's cache makes every later measurement (including the duration refresh in 3) less noisy; Target 3 shares neither runners nor cache with the others and only shares the fail-loud convention.

Expected composed wall for a merge-group run after 1+2+3 of Target 1: warm S0 (~1.5–3 min) + rebalanced slowest shard (~6.5 min, less where concurrency > 1 applies) + ~0.5 min overhead ≈ **8.5–11 min** versus the 15.98 min average, with the 27 min cold tail down to ~12–14 min. Targets are the 20-minute job rule per job, unchanged.

## Hard constraints

- **HoBo projects must NEVER be Git-linked on Vercel or anywhere else. HoBo owns deployment through HoBo CD.**
- Do not link `hobo-ci` (or any HoBo project) to Git on Vercel. The missing link is not a defect to work around but the invariant itself.
- The relay deploy must not wait for or adopt a Vercel Git deployment (no `hobo ci deploy --adopt` / GitHub Deployments API path in `relay-deploy.yml`).
- HoBo CD deploys the commit itself through the Vercel deploy API / CLI with the existing HoBo CD credentials from the relay's secret store; secrets are never printed in docs, logs, or code comments.
- The workflow fails loudly with the real error (the `set -uo pipefail` / masked-summary shape is fixed as part of Target 3).
- The production release approval pending since Nov 12 is Tyler's call; this plan does not change it.
- All changes: SHA-pinned actions only, affected-only Turbo, self-hosted `hobo` JIT runners preferred, no paid tools (Graphite, Aviator, Dagger Cloud) and no new paid infrastructure, the 20-minute job rule, fail-closed gates.

## Out of scope

- Vercel Git linking in any form (prohibited, not merely out of scope).
- The production release approval (Tyler's, pending since Nov 12).
- #2914's vitest file-sharding and planner work itself, and #2915.
- Paid merge-queue, cache, or observability SaaS.
- Runner fleet capacity changes (ARC `minRunners`, box slot counts) beyond freeing existing slots.

## Measure

- **Target 1:** merge-group wall average over the next ~15 merges (expect ≤ 11 min; no run > 15 min); slowest-shard minus second-shard gap < 1 min; PR impact validation's cold band (> 500 s) gone or explained by a cache-server outage; Turbo hit rate above the 36 % baseline on merge-group runs.
- **Target 2:** publisher's `hobo`-label occupancy per green main (expect ~0 for no-image-input pushes); one production observation of the fast path skipping the box job, linked in this finding.
- **Target 3:** relay deploys over the next ~13 pushes: 0 adopt-family refusals; each failure, if any, shows its typed code in the run page; production `/healthz` names the pushed commit without a manual re-run; per-run deploy timing recorded.

## Verified

Design only in this change: `pnpm run docs:findings -- --check` passes (the new finding is unindexed until `docs/ci/performance.md` is next regenerated, a notice by design). No code, workflow, or configuration changed; nothing to run. Every solution above names the seam it would touch; none is implemented here.
