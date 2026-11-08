---
type: Design
title: "CI Runner Balancing Example & Dogfood Record"
description: "Scope, decision policy, and dogfood rollout for the ci-runner-balancing reference example: credit-aware dispatch of CI jobs across GitHub-hosted, self-hosted, and third-party Actions runner providers."
tags: [hobo, design]
---

# CI Runner Balancing Example & Dogfood Record

Production shared-budget CI admission is described in
[shared-budget-policy.md](./shared-budget-policy.md). This variable-rebalancing
example remains a ranking/reference path; it does not supply transactional
financial admission or an absolute spending guarantee.

**Example:** [`examples/ci-runner-balancing/`](../../examples/ci-runner-balancing/README.md) ·
**Ancestry:** [`dispatcher-maximize-credits`](./proofs/hobo-363-dispatcher-maximize-credits/index.md),
[`execution-host-providers`](./proofs/hobo-149-execution-host-providers/index.md),
QuickDeployAI `monorepo/apps/ci-routing-control-plane` + `deployment-watcher` failover ·
**Objective:** [ADR-0071](./adr/01-architecture-core.md#adr-0071) `maximize-credits`

## What it is

The first HoBo reference example that exercises the FinOps dispatch story on a
real workload: this repository's own CI. Jobs consume a routed GitHub Actions
variable (`runs-on: ${{ vars.HOBO_RUNNER_LINUX_SMALL || 'ubuntu-latest' }}`),
and a rebalance pass — command `RebalanceRequested`, actor over a pinned
`CreditLedgerView@seq` projection, `dispatch.Decided` events, Actions-variable
execution adapter — moves that variable across a provider registry seeded from
[neysofu/awesome-github-actions-runners](https://github.com/neysofu/awesome-github-actions-runners)
(Namespace, BuildJet, Actuated, WarpBuild, Blacksmith, Ubicloud, RunsOn,
Cirun, Depot, Cirrus Runners) plus GitHub-hosted and self-hosted pools.

Selection order is the product claim: **(a)** reported usage against each
provider's budget envelope (soft cap = hysteresis basis: leave at ≥90%,
return below 80%; verified spend at the hard cap blocks outright), then
**(b)** effective marginal cost — `0` while free-tier headroom remains, the
declared list price after — so free credits are exhausted before realtime
billing starts, and the cheapest paid rate wins only after every free tier is
drained. Third-party cost facts are `declared-unverified` ranking input;
misdeclared facts degrade to declared min-cost ranking; exhausted candidates
fail closed rather than guessing. Usage reads that cannot be verified mark
their decisions `usage_known: false` — an unverified flip is never presented
as spend-aware routing. `credit.Exhausted` and `meter.UsageRecorded` events
make the ledger auditable; `exec.Succeeded` records each applied patch.

## Dogfood rollout in this repository

- Every Linux job in `.github/workflows/` consumes
  `vars.HOBO_RUNNER_LINUX_SMALL` with an `ubuntu-latest` expression fallback,
  so CI is unchanged until the variable exists and never breaks if it is
  deleted. That includes the Linux legs of the OS-matrix jobs (stage gates,
  componentize); only their Windows legs keep an explicit hosted image, since
  no routed Windows pool exists yet.
- [`rebalance-runners.yml`](../../.github/workflows/rebalance-runners.yml)
  runs the example daily (03:47 UTC) and on manual dispatch: plan mode
  always, apply mode only when a `VARS_ADMIN_TOKEN` secret (PAT with
  repo Variables write) is configured — the default `GITHUB_TOKEN` cannot
  manage variables. The controller job stays pinned to `ubuntu-latest` so it
  cannot be stranded by the variable it manages.
- Third-party rungs are capability-guarded behind `HOBO_RB_ENABLE_<PROVIDER>`
  repo variables and stay ineligible until the corresponding GitHub App or
  runner pool is actually installed; with none enabled the dispatcher holds
  `ubuntu-latest` inside GitHub's included minutes, which is the correct
  cheapest answer while free headroom remains. The failed-run classifier
  (spending limit, minutes quota, runner unavailable, zero-step pickup
  failures) is the reactive backstop that rotates off a blocked provider
  between scheduled passes.
- This repository is private, so GitHub-hosted minutes bill against the
  account's included quota and its Actions spending limit is a real hard
  block — a job refused for spending reasons dies before any step starts,
  which is exactly the evidence the classifier maps to a provider-wide
  `HardBlockSignal`. The offline fixture
  (`fixtures/free-credit-rotation.fixture.json`) replays the same story
  proactively: GitHub's included minutes exhaust while Blacksmith headroom
  remains, and the dispatcher rotates before the wall instead of after it.
- **The machine requesting CI is the final backup.** Every track ends in a
  `last_resort` rung (`hobo-last-resort`, provider `requesting_machine`)
  that ranks behind every normal rung regardless of its declared zero cost:
  when every hosted provider is blocked, the dispatcher fails over to it
  instead of failing closed, and jobs queue until the requester runs the
  example's `host-runner` command — which registers that machine as an
  **ephemeral** self-hosted runner, drains the queue one job per
  registration, and deregisters. Self-hosted minutes are unbilled, so the
  floor costs $0 in Actions spend; `FAIL_CLOSED` survives only for the case
  where even the last resort is blocked. The failover replays offline in
  `fixtures/last-resort-failover.fixture.json`. Ephemeral-only,
  own-branches-only is the stated security posture — the last resort exists
  for the repository's own developers and agents, not for fork traffic. That
  posture is **enforced**: `host-runner` reads the repository record before
  installing or registering anything and refuses a **public** repository
  (`HOST_RUNNER_PUBLIC_REPO_REFUSED`, naming fork pull-request workflows when
  enabled), and fails closed when visibility cannot be read at all
  (`HOST_RUNNER_VISIBILITY_UNKNOWN`); `--allow-public` /
  `HOBO_RB_ALLOW_PUBLIC=1` is the deliberate override.
- **When even a runner cannot be had, the CI work itself defers to the
  requesting machine.** Sandboxed agent sessions cannot register runners
  (their egress proxy forbids the GitHub Actions API by policy), so the
  example's `local-gate` command runs the same suite as the hosted pr-gate
  job — relevant checks against the base, Turbo affected lanes, the
  production-packages build — on the requesting machine and folds the
  results into `golden.Ran`/`golden.Passed` evidence, Turborepo-style: the
  requester does the work, the hosted lane replays it. The resilience
  ladder is hosted providers → ephemeral last-resort runner → local gate.

## Scope boundary

Reference and contract-proof artifact per
[`example-apps.md`](./example-apps.md) — not a hosted service with an SLA. No
billing (ADR-0064), no reservation-CAS double-spend seam (stays with the
`dispatcher-reservation` proofs), no live provider SDKs beyond declared
usage, no Windows/macOS/GPU tracks yet (they are additional `RunnerTrack`
records). The router core never names providers; names live in registry data
and adapters below the execution-adapter boundary
([`finops-budget-routing-control-plane.md`](./finops-budget-routing-control-plane.md)).
