---
type: Implementation Plan
title: "Relay routing slips: the box relay hands each run its route"
description: "Replace every environment variable and repository variable on the runner-routing path with a routing slip the box relay writes per run, and with routing policy committed to .hobo/ci.json. Retire the hosted relay's verdict path."
tags: [hobo, ci, relay, routing, fleet, plan]
---

# Plan 0026 — Relay routing slips

**Status:** In progress. **Supersedes for transport:** ADR-0180's hosted
verdict read (plan 0025 layers 02, 04 relay ask). **Decision record:**
ADR-0181 ([routing slips](../design/adr/routing-slips.md#adr-0181)).

## 1. Owner rules (binding)

- **R1** The relay (fleet host) decides routing. Workers and workflows do not
  judge capacity.
- **R2** No environment variable and no repository variable carries routing
  or fleet information, or a routing setting, anywhere: workflows, actions,
  the route script, the box daemon, the reporter, the hosted relay. Routing
  travels as a **routing slip** written by the relay, and routing policy is
  committed configuration.
- **R3** Unknown changes nothing: with no slip, routing behaves as it does
  today (the queue rule).
- **R4** A box that is only busy with its own jobs is never refused.
- **R5** Nothing is handed to the owner as a task. What the code cannot do
  itself is stated as a fact in the finding, once.

**Boundary of R2.** Platform-provided runtime context (`GITHUB_*`,
`RUNNER_*`, `GITHUB_TOKEN`), credentials, and settings unrelated to routing
(build, test, telemetry) are not routing information. Everything that
chooses a runner label, a tier, a pool, a slot split, a limit or a reporter
is.

## 2. Facts (verified 2026-11-13; evidence in finding 0149)

1. `main` runs go to `ubuntu-24.04` because the queue rule refuses the fleet
   (pickups up to 307 s against a 120 s limit). The hosted relay answers 503
   (its Vercel project lost its GitHub link after #1883; `/readyz`
   `store-unavailable`), which only removes its veto.
2. The box daemon runs `c7ec8d449` (#1883). It does not run the verdict
   reporter. It has no self-update and its startup log has no version.
3. The App holds `contents: write`, `actions: write`,
   `administration: write`; not `checks`, `statuses` or `variables`.
4. The route job's token has `actions: read`, `contents: read`. A git ref is
   the one per-run channel the box can write today and the job can read.
5. All five routing repository variables (`HOBO_CI_ROUTE`,
   `HOBO_CI_LOCAL_RUNNER`, `HOBO_CI_ROUTE_MAX_WAIT_SECONDS`,
   `HOBO_CI_ROUTE_MAX_QUEUED`, `HOBO_CI_TRUNK_RUNNER`) read empty in
   production runs; whether `HOBO_CI_FLEET_ROUTES/_STATE/_CAPACITY` exist is
   unknown (the proxy refuses the variables API).

## 3. Design

### 3.1 The routing slip

A protobuf record `RoutingSlip` (`packages/ci-gh-actions/data-models/routing_slip.proto`,
CUE `#RoutingSlip` in `data-models/onboarding.cue`, valid and invalid
fixtures):

| Field | Meaning |
| --- | --- |
| `version` | 1 |
| `repository` | `owner/name`, lower case |
| `run_id`, `run_attempt`, `head_sha`, `workflow` | the run it was written for; the route job refuses a slip that names another run, attempt or commit |
| `issued_at`, `expires_at` | the relay's clock; lifetime 10 minutes; a reader treats an expired slip as absent |
| `runners` | map job class → label: `pr`, `fork`, `trunk`, `shard` (the classes of `#FleetRoutes`) |
| `tier` | `fleet`, `local` or `github` for the class the run belongs to |
| `reason` | one line a person reads in the route log |
| `relay` | `{node_id, commit}`: which relay and which code wrote it |

No slot count, memory figure or reporter identity leaves the relay beyond
`relay`.

### 3.2 Where it lives

`refs/hobo/routing-slips/<run_id>` → a parentless commit whose tree is the
empty tree and whose **message** is the slip's JSON. Writing: blob-free,
`POST /git/trees` (empty or one-file tree, created once and reused),
`POST /git/commits`, `POST /git/refs` (or `PATCH` for a new attempt). Reading
(route job, `GITHUB_TOKEN`, `contents: read`): `GET /git/ref/hobo/routing-slips/<id>`
then `GET /git/commits/<sha>`; two calls, no checkout. The relay deletes a
slip ref when its run completes (the poller already sees completions) and
sweeps refs older than 24 hours on start and hourly. Non-branch refs
trigger no workflow and are not shown in the UI.

**Trust.** Only holders of `contents: write` can write a ref: the relay's App
and repository writers, who can already edit workflows. Fork pull requests
cannot. The binding to run id, attempt and head SHA stops replay. No
signature is added: the only keys a reader could trust would themselves
have to be committed by a person (R5).

### 3.3 Who writes it and how it decides

The box relay (daemon) writes a slip for every queued run of a routed
workflow it sees in its poll (≤ 2 s after the run is queued). It decides
with what only it holds:

1. **Fleet can take it** when a node serving the class's label is live and
   either has a free slot, or can admit by memory once a slot frees (R4:
   busy is not refusal), **or** an external pool from committed config (ARC,
   counted from `GET /repos/{r}/actions/runners` by label and `busy`, which
   `administration` permits) has a free runner.
2. **Refuse the fleet** (`tier: github`) only when no node serves the label
   (`no-node`), or every node refuses for a reason other than its own
   running jobs and no pool has a free runner (`no-capacity`): the existing
   `fleet-verdict-evaluator.ts` rule, reused, with its enter/exit hysteresis.
3. **Local** when the committed config enrolls a local box for the class and
   the fleet is refused.
4. **Pins** from committed policy (`routing.pin`) are written into the slip
   unchanged.

The relay also writes a fresh slip when the run's second ask (main gate
before shards) is made: the main-gate plan job reads the slip ref again;
the relay rewrites it on each dispatch pass while the run is in progress.

### 3.4 Committed routing policy

`.hobo/ci.json` gains `routing` (zod parser in `relay-routing.ts`, JSON
Schema regenerated, CUE `#RoutingPolicy` + fixtures):

```json
"routing": {
  "pin": "auto",
  "slipWaitSeconds": 20,
  "queue": { "maxWaitSeconds": 120, "maxQueued": 4 },
  "labels": { "fleet": "hobo", "trunk": "hobo-trunk", "local": "hobo-local-host", "github": "ubuntu-24.04" },
  "localRunner": false,
  "verdict": { "minFreeRunners": 1, "enterMs": 60000, "exitMs": 120000 },
  "box": { "trunkSlots": 1, "trunkLend": 0, "prCapWithTrunk": 2, "slots": 2, "capacityVolatilityMb": 1024, "trunkHeadroomFleetDeferMs": 180000 },
  "retiredVariables": ["HOBO_CI_FLEET_ROUTES", "HOBO_CI_FLEET_STATE", "HOBO_CI_FLEET_CAPACITY", "HOBO_CI_ROUTE", "HOBO_CI_LOCAL_RUNNER", "HOBO_CI_ROUTE_MAX_WAIT_SECONDS", "HOBO_CI_ROUTE_MAX_QUEUED", "HOBO_CI_TRUNK_RUNNER"]
}
```

Values shown are today's defaults, so moving them changes no behavior. The
external pools are derived from the enabled `providers` entries with a
`scaleSet` (ARC); the reporter id is the mesh node id. The box daemon reads
the file from its checkout at start and on every self-update; the route job
reads it from its sparse checkout (already checked out).

### 3.5 The route job

1. Read `routing` from `.hobo/ci.json`. Read the dispatch input `route` as
   an **argument** (`--pin`), not an environment variable.
2. Poll the slip ref for this run every 2 s up to `slipWaitSeconds`. A slip
   for this run, attempt and SHA that has not expired decides: outputs
   `runner`, `tier`, `shard_runner` from it; log `relay: slip <node>@<commit>, <reason>`.
3. No valid slip: the queue rule decides exactly as today (R3), using the
   committed limits; the titled warning `hobo-ci-route-fallback` says
   `no routing slip within N s`.
4. The hosted relay is not asked (`askRelay` and its tests removed).

### 3.6 Workflows

- Every `vars.HOBO_CI_*` routing input is removed from route jobs.
- Routed `runs-on`: `${{ needs.route.outputs.runner || 'ubuntu-24.04' }}`
  (shards: `shard_runner`). The literal fallback applies only when the
  route job itself failed.
- Unrouted always-fleet jobs (`ci-deps-image`, `ci-deps-publish`,
  `fleet-enrollment`, `dev-env-smoke`, `examples-e2e`,
  `hobo-ci-acceptance`, release jobs listed in finding 0149): `runs-on:
  hobo-trunk`, the value the unset variable resolved to.
- `fleet-probe.yml`: the trunk probe always runs; the local-box probe is
  gated by a one-step job that reads `routing.localRunner` from
  `.hobo/ci.json` (sparse checkout) and outputs it.
- A step in each route job, with only expression conditions, warns
  `hobo-ci-retired-variable` naming any `vars.<retired>` that is non-empty.
  No value is passed to a step.
- `scripts/lint-actions.ts` bans, in workflows and actions, any
  `vars.HOBO_CI_*` and any env, input or output named for a retired
  variable; the pinned `runs-on` strings change to the forms above.

### 3.7 Retiring repository variables

At daemon start and once per hour, the relay sends
`DELETE /repos/{r}/actions/variables/{name}` for each
`routing.retiredVariables` entry. 204 and 404 are success; 403 logs
`hobo_ci_variable_retire_refused` once per hour and continues. The
`HOBO_CI_FLEET_ROUTES` publisher (`fleet-routes.ts` write path) is deleted.

### 3.8 The relay keeps itself current

The daemon logs `commit` at start and in every slip. Every 10 minutes it
fetches `origin main`; when its checkout is behind and the new head is on
main's first-parent line, it drains (existing drain), checks out the new
head, and exits with the restart code its supervisor already restarts
(`restart-worker.sh` semantics). A failing start after an update logs and
keeps running the old checkout (it re-execs only after the new code passes
its own `--self-check`).

### 3.9 Hosted relay

The verdict routes (`GET/PUT /v1/fleet/verdicts`, `/v1/fleet/reporters`),
their stores, `HOBO_CI_FLEET_REPORTERS_JSON`, `HOBO_CI_FLEET_VERDICT_SERVING`,
`HOBO_CI_FLEET_VERDICT_DAILY_BLOCK_MINUTES`, the reporter's PUT, the client,
the PACT `fleet-verdict-boundary` and `fleet_verdict.proto` are removed. The
evaluator stays (it now feeds slips). ADR-0180 is marked superseded by
ADR-0181 for transport.

## 4. Failure scenarios

| Failure | Behavior |
| --- | --- |
| Box down or not yet updated | No slip within 20 s: queue rule (today's behavior). Monitor H-signal counts `no routing slip` |
| Slip for another run/attempt/SHA, expired, malformed | Treated as absent; logged with the reason |
| GitHub API error reading the ref | Treated as absent after the wait |
| Ref write refused (ruleset, permission) | Relay logs `hobo_ci_slip_write_refused` with status, backs off 10 min; routing falls back per row 1 |
| Relay crashes after writing | Slip expires in 10 min; refs swept hourly |
| Variable delete refused | Logged; routing never reads variables, so no effect |
| Self-update to a broken commit | Self-check fails; old checkout keeps running; logged |
| Burst of runs | One ref per run; GitHub secondary rate limit: relay writes at most 1 slip/s, skips runs older than 2 min |

## 5. Delivery: stacked PRs

| Layer | Branch | Content | Depends |
| --- | --- | --- | --- |
| 01 | `sdlc/slips-01-contracts` | `routing_slip.proto`, CUE, fixtures, parser (`src/routing-slip.ts`), `routing` policy in `.hobo/ci.json` + zod + schema + CUE, ADR-0181, this plan, finding 0149 | main |
| 02 | `sdlc/slips-02-box-issuer` | slip writer + sweeper, decision (3.3), policy read from checkout, every routing `process.env` read removed from daemon/reporter/worker-slots, variable retirement, `fleet-routes` writer deleted, `commit` in logs, self-update | 01 |
| 03 | `sdlc/slips-03-route-workflows` | route script reads slip + policy, `--pin` argv, `askRelay` removed, action inputs removed, all workflows (3.6), lint ban, main-gate reroute reads slip | 01 |
| 04 | `sdlc/slips-04-hosted-retire` | 3.9 | 03 |
| 05 | `sdlc/slips-05-docs-guards` | RUNNER-QUEUE, ci-relay-mesh, ci-fleet-balancing, plan 0025 status, monitor signal for `no routing slip`, a source guard test: no `process.env.HOBO_CI_(ROUTE|TRUNK|LOCAL|FLEET|WORKER_.*SLOTS)` in scripts/packages | 02, 03, 04 |

02 and 03 are built in parallel against 01.

## 6. Measurable outcomes

| Id | Outcome | Check |
| --- | --- | --- |
| M1 | Zero `vars.HOBO_CI_*` in `.github/` except the retired-variable warning conditions | lint-actions test |
| M2 | Zero routing `process.env.HOBO_CI_*` reads in `scripts/`, `packages/ci*` | source guard test |
| M3 | Route job decides from a valid slip in ≤ slipWaitSeconds + 1 s | route-runner test with a fake GitHub API |
| M4 | A slip for another run/attempt/SHA, expired or malformed is never used | parser + route tests, invalid fixtures |
| M5 | No slip → identical outputs to today's queue rule on the recorded production cases | route-runner replay tests |
| M6 | Box busy with own jobs + memory to admit → slip says fleet (R4) | evaluator/issuer test |
| M7 | Variable retirement: 204/404 success, 403 logged, never throws | unit test with recorded responses |
| M8 | Self-update never replaces a running checkout with one that fails `--self-check` | daemon test |
| M9 | Hosted relay has no `/v1/fleet/` route; no `fleet_verdict` proto | tests + codegen check |
| M10 | All gates green on each layer: `test:scripts`, actions lint, architecture guard, codegen, schema, docs freshness, the touched packages' build/typecheck/lint/test | CI |
