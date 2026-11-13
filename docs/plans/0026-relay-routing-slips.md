---
type: Implementation Plan
title: "Relay routing slips: the box relay hands each run its route"
description: "Replace every environment variable and repository variable on the runner-routing path with a routing slip the box relay writes per run, and with routing policy committed to .hobo/ci.json. Retire the hosted relay's verdict path."
tags: [hobo, ci, relay, routing, fleet, plan]
---

# Plan 0026 — Relay routing slips

**Status:** Done (layers 01-05; deviations in section 7). **Supersedes for transport:** ADR-0180's hosted
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
2. The box daemon runs `c7ec8d449` (#1883). It has no update path, its jobs
   run in containers with no host access, and its startup log has no
   version. **It takes the new code only after it is restarted once**; from
   then on it keeps itself current (3.8). This is a fact of the box, stated
   once in finding 0149, not a task.
3. The App holds `contents: write`, `actions: write`,
   `administration: write`; not `checks`, `statuses` or `variables`.
4. The route job's token has `actions: read`, `contents: read`, and the job
   runs from a sparse checkout with nothing installed.
5. The five routing repository variables read empty in production runs;
   whether `HOBO_CI_FLEET_ROUTES/_STATE/_CAPACITY` exist is unknown (the
   proxy refuses the variables API).
6. `main` pushes queue behind the running `main` run, often for more than
   10 minutes (`hobo-ci.yml:40-50`).
7. GitHub's secondary limit is 80 content-creating requests a minute and 500
   an hour, shared with the box's job polling and runner registration.

## 3. Design

### 3.1 The routing slip

One slip per repository: the relay's current routing answer, rewritten when
it changes. A protobuf record `RoutingSlip`
(`packages/ci-gh-actions/data-models/routing_slip.proto`; CUE `#RoutingSlip`
in `data-models/onboarding.cue`; valid and invalid fixtures):

| Field | Meaning |
| --- | --- |
| `version` | 1 |
| `repository` | `owner/name`, lower case |
| `issued_at`, `expires_at` | the relay's clock; lifetime 10 minutes; rewritten at least every 3 minutes while the relay is up |
| `classes` | map class → `{runner, tier, reason}` for `pr`, `fork`, `trunk` (the classes of `#FleetRoutes`); shards use `trunk` on trunk events and `pr` otherwise |
| `relay` | `{node_id, commit}` |

`tier` is `fleet`, `local` or `github`. `reason` is a code
(`fleet-open`, `fleet-busy`, `no-node`, `no-capacity`, `stalled`, `pinned`),
never a figure. No slot count or memory figure leaves the relay.

### 3.2 Where it lives

`refs/hobo/routing-slip` → a parentless commit whose tree is a one-file tree
(created once and reused) and whose **message** is the slip's JSON. Written
with `POST /git/commits` then `PATCH /git/refs/hobo/routing-slip`
(`force: true`; `POST /git/refs` the first time). Read by the route job with
`GITHUB_TOKEN` and `contents: read`: `GET /git/ref/hobo/routing-slip`, then
`GET /git/commits/<sha>`. Layer 01 includes a probe test, run by the
implementer against the live repository, that proves the write and read
calls before anything builds on them.

**Write budget.** The relay writes when the decision changes and as a
heartbeat every 3 minutes: ≤ 2 writes per change, ≤ 40 per hour in steady
state, hard-capped at 20 per minute and 300 per hour; a 403 or 429 backs off
10 minutes. Only the **mesh leader** writes (the existing leader election);
a box without a mesh is its own leader.

**Trust.** Only holders of `contents: write` can write the ref. The route
job accepts a `runner` only when it is one of the committed
`runnerRouting.labels` (3.4); anything else makes the slip invalid. No
signature: the keys a reader could trust would have to be committed by a
person (R5).

### 3.3 How the relay decides

Per class, from what only the relay holds:

1. **Refuse the fleet** (`tier: github`) when no live node serves the
   class's label (`no-node`); or when every node refuses for a reason other
   than its own running jobs, which includes critical host or storage health
   **whether or not the node is busy**, and no external pool has a free
   runner (`no-capacity`); or when work has been assigned to the label and
   nothing has started for 10 minutes (`stalled`, the `stall-job-recovery`
   signal). The existing `fleet-verdict-evaluator.ts` rule and its
   enter/exit hysteresis are reused, extended for the busy-health and stall
   cases.
2. Otherwise the fleet label (`fleet-open`, or `fleet-busy` when every slot
   is taken: R4, busy is never refusal).
3. **Local** instead of GitHub-hosted when committed config enrolls a local
   box and the fleet is refused.
4. A committed `runnerRouting.pin` is written into every class (`pinned`).
5. **Forks** use `classes.fork`, never the trunk label.
6. An external pool counts as free only when it can be counted (repo-level
   runners with its label, `busy: false`, via `GET /actions/runners`, which
   `administration` allows). A pool that cannot be counted is "unknown" and
   never allows a refusal (R3).

**What this changes, and what is measured.** With slips, `main` returns to
the fleet while it is merely slow, as R4 asks: four shards may queue behind
one trunk slot. Finding 0149 records, before and after, the pickup p95,
main-gate duration and GitHub-hosted minutes per day.

### 3.4 Committed routing policy

`.hobo/ci.json` gains `runnerRouting` (named to avoid
`environments.*.policy.routing`): zod parser in `relay-routing.ts`, JSON
Schema regenerated, CUE `#RunnerRouting` and fixtures. Values are the code
defaults today, so moving them changes nothing:

```json
"runnerRouting": {
  "pin": "auto",
  "queue": { "maxWaitSeconds": 120, "maxQueued": 4 },
  "labels": { "fleet": "hobo", "trunk": "hobo-trunk", "local": "hobo-local-host", "github": "ubuntu-24.04" },
  "localRunner": false,
  "mainWorkspaceParallelCap": 4,
  "verdict": { "minFreeRunners": 1, "enterMs": 60000, "exitMs": 30000, "stallMs": 600000 },
  "box": {
    "slots": 2, "trunkSlots": 1, "trunkLend": 0, "prCapWithTrunk": 1, "mergeGroupLeases": 1,
    "capacityVolatilityMb": 1024, "trunkHeadroomFleetDeferMs": 45000, "jobAdmission": "pull"
  },
  "externalPools": [],
  "retiredVariables": ["HOBO_CI_FLEET_ROUTES", "HOBO_CI_FLEET_STATE", "HOBO_CI_FLEET_CAPACITY", "HOBO_CI_ROUTE", "HOBO_CI_LOCAL_RUNNER", "HOBO_CI_ROUTE_MAX_WAIT_SECONDS", "HOBO_CI_ROUTE_MAX_QUEUED", "HOBO_CI_TRUNK_RUNNER"]
}
```

The implementer reads every default from the code (`worker-slots.ts`,
daemon, `fleet-verdict-state.ts`, `route-runner.mts`,
`plan-main-workspace-shards.mts`) and the test asserts the committed values
equal them. Checked in layer 01: every value above is the code's default
except `verdict.stallMs`, which no code holds yet; 600000 is this plan's
ten minutes (3.3). The zod schema is `src/runner-routing.ts` (a leaf module,
since `project-schema.ts` embeds it and `relay-routing.ts` imports
`project-schema.ts`); `parseCiRunnerRouting` in `relay-routing.ts` reads it
from the file. The daemon reads the file from its checkout at start; at start
it also logs once the **names** (never values) of any retired environment
variable still set on the box, so a box-local override that stops applying
is visible. The route job and the main-gate plan read it with a
dependency-free reader (`scripts/ci/runner-routing.mts`, in the style of
`fleet-overflow.ts`), added to every route job's sparse checkout.

**What counts as routing (R2), exhaustively:** `HOBO_CI_ROUTE`,
`HOBO_CI_ROUTE_MAX_WAIT_SECONDS`, `HOBO_CI_ROUTE_MAX_QUEUED`,
`HOBO_CI_TRUNK_RUNNER`, `HOBO_CI_LOCAL_RUNNER` (the repository variable; not
`scripts/local-runner.ts`'s switch), `HOBO_CI_INCLUDE_OWN_RUN`,
`HOBO_CI_ATTESTED`, `HOBO_CI_FLEET_ROUTES`, `HOBO_CI_FLEET_VERDICT_*`,
`HOBO_CI_FLEET_REPORTER_ID`, `HOBO_CI_FLEET_EXTERNAL_POOLS_JSON`,
`HOBO_CI_FLEET_REPORTERS_JSON`, `HOBO_CI_FLEET_CAPACITY_VOLATILITY_MB`,
`HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS`, `HOBO_CI_WORKER_SLOTS`,
`HOBO_CI_WORKER_TRUNK_SLOTS`, `HOBO_CI_WORKER_TRUNK_LEND`,
`HOBO_CI_WORKER_PR_CAP_WITH_TRUNK`, `HOBO_CI_WORKER_MERGE_GROUP_LEASES`,
`HOBO_CI_JOB_ADMISSION`, `MAIN_WORKSPACE_PARALLEL_CAP`, and the pool label
and providers carried by `HOBO_CI_CONFIG`/`HOBO_CI_CONFIG_JSON` (the daemon
takes labels and providers from `.hobo/ci.json` instead; those two keep only
what is not routing). `HOBO_CI_RELAY_URL` names a relay and is written as a
literal by onboarding; it is not routing. `HOBO_CI_MERGE_QUEUE_BRANCH` names
a branch, not a runner; it is not routing.

### 3.5 The route job

1. Read `runnerRouting` with the dependency-free reader. The dispatch input
   `route` becomes `type: choice` (`auto`, `fleet`, `local`, `github`) and
   reaches the script as an argument, as do `include-own-run` and
   `attested` (argv, never env).
2. Read the slip once (two GET calls, 3 s limit). A slip that has not
   expired, names this repository and whose runners are all allowed
   decides: `runner`, `tier`, `shard_runner` for the run's class; the log
   says `relay: slip from <node>@<commit>, <reason>`.
3. No valid slip: the queue rule decides immediately, exactly as today (R3).
   This is the workflow judging the queue, allowed only by R3. The titled
   warning `hobo-ci-route-fallback` says why (`no routing slip`, `slip
   expired`, `slip names a label not in runnerRouting.labels`, ...).
4. The hosted relay is no longer asked (`askRelay` removed).
5. The main gate's second ask reads the slip again (it may have changed).

### 3.6 Workflows

- Every `vars.HOBO_CI_*` is removed from every workflow, action and
  template (`templates/hobo-ci-smoke.yml` with `hobo-ci-acceptance.yml`,
  keeping their pinned digest in step).
- Routed `runs-on`: `${{ needs.route.outputs.runner || 'ubuntu-24.04' }}`
  (shards: `shard_runner`). This changes one unknown: a route job that
  itself fails now sends the run to GitHub-hosted rather than the fleet; the
  route action already does that when its script fails.
- Unrouted jobs keep their event test with the variable removed:
  `${{ contains(fromJSON('["push","workflow_dispatch","merge_group","workflow_run"]'), github.event_name) && 'hobo-trunk' || 'hobo' }}`.
- `fleet-probe.yml`: the trunk probe always runs; the local-box probe is
  gated by a one-step job that reads `runnerRouting.localRunner` from
  `.hobo/ci.json` with the reader.
- `scripts/lint-actions.ts` bans every `vars.HOBO_CI_*` and every env,
  input or output named in 3.4's list, and pins the new `runs-on` strings.

### 3.7 Retiring repository variables

The owner asked for the variables to be deleted. At each daemon start the
leader sends one `DELETE /repos/{r}/actions/variables/{name}` per
`retiredVariables` entry. 204 and 404 are success; 403 is logged once for
that start (`hobo_ci_variable_retire_refused`, naming the variables) and
never retried in that process. Nothing reads these variables after layer
02, so their presence changes nothing. The `HOBO_CI_FLEET_ROUTES` publisher
(`fleet-routes.ts` write path) is deleted.

### 3.8 The relay keeps itself current

- The daemon logs `commit` at start and in every slip (`relay.commit`).
- Every 3 hours, and only when the box is idle, the leader fetches
  `origin main`. When main's head is on its first-parent line, and the
  daemon's own paths (`packages/ci-gh-actions`, `packages/ci`, the lockfile,
  the daemon scripts) changed, it prepares the new head in a **separate
  worktree**: `pnpm install --frozen-lockfile`, submodule update, build, and
  `--self-check` (a new entry that loads the daemon's modules and config and
  exits 0).
- Only after that passes does it stop with the existing `handoff` mode (the
  next daemon adopts running containers) and re-exec itself in place with
  `process.execve` on the new worktree: same PID, so no supervisor is
  assumed. A failing preparation logs `hobo_ci_self_update_refused` and the
  old code keeps running; the same head is not retried for 24 hours.

### 3.9 Hosted relay

Removed: the verdict routes (`GET/PUT /v1/fleet/verdicts`,
`/v1/fleet/reporters`), their stores and auth (`fleet-verdict-auth.ts`,
`fleet-verdict-cache.ts`), `client.ts` verdict calls, `hosted-control.ts`
and `http-handler.ts` routes, `cloud-events.ts` verdict events, the reporter
PUT, `scripts/fleet-reporter-enroll.mts`, the PACT
`fleet-verdict-boundary`, `fleet_verdict.proto`, their `index.ts` exports
and the `ci-vercel` imports (`bindle.ts`, `stateless-composition.ts`).
`relay_runtime_config` field numbers are reserved, and the runtime config
loader **accepts and ignores** the retired keys (`HOBO_CI_FLEET_*`) so a
store that still holds one does not stop the relay. The evaluator stays
(it feeds slips). `relay-deploy.yml`'s verdict probe and `ci-health.mts`'s
relay-status reads move in the same layer that removes what they read.
ADR-0180 is marked superseded by ADR-0181 for transport.

## 4. Failure scenarios

| Failure | Behavior |
| --- | --- |
| Box down, not restarted onto new code, or no leader | No slip or an expired one: queue rule at once (today's behavior); the monitor counts `no routing slip` |
| Slip malformed, wrong repository, unknown label | Invalid: queue rule; warning names the reason |
| GitHub API error or 3 s timeout reading the ref | Queue rule |
| Ref write refused or rate-limited | `hobo_ci_slip_write_refused` with status; 10-minute back-off; the old slip expires within 10 minutes |
| Relay crashes after writing | Slip expires within 10 minutes |
| A node wedged with jobs assigned | `stalled` after 10 minutes: refused |
| Box busy with its own jobs, healthy | `fleet-busy`: the fleet (R4) |
| Fork pull request | `classes.fork` (the fleet's `hobo` label, or GitHub-hosted when refused); never trunk |
| Variable delete refused | Logged once per start; routing never reads variables |
| Self-update preparation fails | Old code keeps running; head skipped for 24 hours |
| Retired keys left in the hosted relay's store | Ignored; the relay starts |

## 5. Delivery: one linear stack

| Layer | Branch | Content |
| --- | --- | --- |
| 01 | `sdlc/slips-01-contracts` | `routing_slip.proto`, CUE, fixtures, `src/routing-slip.ts` parser; `runnerRouting` in `.hobo/ci.json` + zod + schema + CUE; the dependency-free reader `scripts/ci/runner-routing.mts` (policy and slip); the Git-API probe test; ADR-0181; this plan; finding 0149 |
| 02 | `sdlc/slips-02-route-workflows` | route script reads slip + policy; argv for `route`/`include-own-run`/`attested`; `route` as `type: choice`; `askRelay` removed; every workflow, action and template (3.6); lint ban; main-gate second ask; `ci-health.mts` reads the new route notice; `MAIN_WORKSPACE_PARALLEL_CAP` from policy |
| 03 | `sdlc/slips-03-box-issuer` | slip writer (leader, budget), decision (3.3), policy from checkout, every routing `process.env` read removed from daemon/reporter/worker-slots/worker-store/config, retired-name log, variable retirement, `fleet-routes` writer deleted, `commit` in logs |
| 04 | `sdlc/slips-04-hosted-retire` | 3.9, with `relay-deploy.yml` and `ci-health.mts` relay-status changes |
| 05 | `sdlc/slips-05-self-update-docs` | 3.8; RUNNER-QUEUE, ci-relay-mesh, ci-fleet-balancing, plan 0025 status; monitor signal `no routing slip`; source guard test over 3.4's list |

Each layer is based on the one below and merged bottom-up.

## 6. Measurable outcomes

| Id | Outcome | Check |
| --- | --- | --- |
| M1 | No `vars.HOBO_CI_*` in `.github/` or `packages/ci-gh-actions/templates/` | lint-actions test |
| M2 | No `process.env` read of any name in 3.4's list in `scripts/`, `packages/ci*` | source guard test |
| M3 | A valid slip decides; route job adds ≤ 3 s; no slip adds 0 s wait | route-runner tests with a fake GitHub API (one that never answers ends at the 3 s limit) |
| M4 | An expired, malformed, wrong-repository or unknown-label slip is never used | reader tests, invalid fixtures |
| M5 | No slip → identical outputs to today on the recorded production cases | route-runner replay tests |
| M6 | Busy + healthy → `fleet-busy`; busy + critical disk → refused; assigned + nothing started 10 min → `stalled` | evaluator/issuer tests |
| M7 | Slip writes ≤ 20/min and ≤ 300/h under a 100-run burst; one writer per mesh | issuer test with a fake clock |
| M8 | Committed `runnerRouting` values equal the code defaults | policy test |
| M9 | Variable retirement: 204/404 success, 403 logged once, never throws | unit test |
| M10 | Self-update never re-execs onto a head whose preparation failed; re-exec keeps the PID and adopts containers | daemon test |
| M11 | Hosted relay has no `/v1/fleet/` route; it starts with retired keys present | tests + codegen check |
| M12 | Every layer: `test:scripts`, actions lint, architecture guard, codegen, schema, docs freshness, and build/typecheck/lint/test of touched packages, all green in CI | CI |

## 7. As built: deviations

Recorded when layer 05 landed. Everything else is as written above.

- **Self-update runs on every box, not only the leader** (3.8). A follower
  that waited for leadership would never update; the leader rule matters
  only for writing slips and retiring variables, and stays there. The check
  "on main's first-parent line" is built as: the oldest commit `main` added
  since the running commit has the running commit as its first parent, so a
  box moves only forward along `main` and never onto a merged side branch.
  The first look is one interval after the daemon starts.
- **Self-update settings are committed policy.** `runnerRouting.selfUpdate`
  (`{"enabled": true, "intervalHours": 3}`) joins the block of 3.4, in the
  zod schema, the reader, `#RunnerRouting`, the JSON Schema and the fixtures.
- **`--self-check` found two faults in the daemon** that would have broken a
  stop: the repeat-signal path imported a module path that does not exist at
  run time, and the drain assigned an undeclared variable, so every stop
  threw before its handoff. Both are fixed; the self-check runs in the
  package's tests (its run-time reach of `@hobo/ci` is declared in
  `scripts/test-deps-runtime-reaches.json`).
- **Labels and providers from `.hobo/ci.json`** (3.4, the layer-03 gap). The
  box's own isolated offers take `runsOn`, provider kind and `enabled` from
  the committed provider with the same `id` whose `connectionRef` is the
  box's provider account; the mesh advert, the slip decision and the stall
  watch use `runnerRouting.labels`. An offer no committed provider names
  keeps its configured values and is logged (R3).
  `HOBO_CI_CONFIG`/`HOBO_CI_CONFIG_JSON` keep accounts, budgets and
  connections.
- **The live transport proof runs in the CI health workflow**, on every push
  to `main` and on its two-hour schedule, as its own GitHub-hosted job that
  alone holds `contents: write` and touches only
  `refs/hobo/routing-slip-probe`; it is not a job of the main gate, which
  would put a write token beside the jobs that build and test repository
  code. A push runs only the probe (the monitor job is skipped), in its own
  concurrency group so it never replaces a waiting scheduled monitor run.
- **M2's guard** is `scripts/test/routing-name-guard.test.ts`: it fails on a
  `process.env`/`env.` read, a `vars.` reference or a YAML key of any name in
  3.4, over `scripts/`, `packages/ci*`, `.github/` and the templates. The
  only allowed read is `packages/ci-gh-actions/scripts/local-runner.ts`'s own
  `HOBO_CI_LOCAL_RUNNER` switch (the plan wrote `scripts/local-runner.ts`).
- **The monitor's count** of fallbacks by reason is `slipFallbacks` in every
  CI health report, beside H2 and H3.
