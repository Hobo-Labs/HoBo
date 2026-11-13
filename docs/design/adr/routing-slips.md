---
type: Architecture Decision Record
title: "The Box Relay Hands Each Run Its Route on a Routing Slip"
description: "The box relay writes its routing answer for a repository as a routing slip, the message of a parentless commit at refs/hobo/routing-slip, which the route job reads with its own token. Routing policy is committed in .hobo/ci.json. No environment variable or repository variable carries routing; the hosted relay's verdict path is retired."
tags: [hobo, design, adr, ci, relay, routing, fleet]
---

# ADR-0181 — The Box Relay Hands Each Run Its Route on a Routing Slip {#adr-0181}

**Status:** Accepted. Built: the record (`RoutingSlip`), its parsers and
writer, the committed policy (`runnerRouting`), the dependency-free reader
and the Git Data API probe
(layer 01). Not built:
the rest ("Not built" below).
**Date:** 2026-11-13
**Supersedes, for transport:** [ADR-0180](fleet-verdict.md#adr-0180)'s
hosted verdict read (`GET /v1/fleet/verdicts/{owner}/{repo}` and the signed
reports behind it). ADR-0180's rule stands: the relay decides, and no
capacity figure leaves it.
**Amends:** [CI Relay Mesh](../ci-relay-mesh.md), "Routing reads the mesh when
it can"; [CI fleet balancing](../ci-fleet-balancing.md), "The route table".

## Context

The route job picks one `runs-on` label for a run before its jobs queue. It
decides from GitHub's queue, and since ADR-0180 it also asks the hosted relay
for a verdict. On 2026-11-13 the hosted relay answers 503 (its store is
unavailable), so the queue decides alone, and main runs go to GitHub-hosted
because the slowest pickup in the hour (307 s) is over the 120 s limit
([finding 149](../../ci/findings/0149-routing-slip-facts-main-on-the-queue-rule-hosted-relay-down-box-on-c7ec8d449.md)).
The verdict travelled from the box to the hosted relay and back to the route
job: two hops, one of them down.

Routing settings also travel as repository variables (`HOBO_CI_ROUTE`,
`HOBO_CI_TRUNK_RUNNER`, …) and box environment variables
(`HOBO_CI_WORKER_SLOTS`, `HOBO_CI_FLEET_VERDICT_*`, …). They are empty or
unset in production, invisible in review and differ per box. The owner ruled
(R1–R5 below): the relay decides; no environment or repository variable
carries routing; unknown changes nothing; a box busy with its own jobs is
never refused; nothing is handed to the owner as a task.

## Rules {#adr-0181-rules}

- **R1** The relay (fleet host) decides routing. Workers and workflows do not
  judge capacity.
- **R2** No environment variable and no repository variable carries routing
  or fleet information, or a routing setting, anywhere: workflows, actions,
  the route script, the box daemon, the reporter, the hosted relay. Routing
  travels as a routing slip written by the relay, and routing policy is
  committed configuration (`runnerRouting` in `.hobo/ci.json`).
- **R3** Unknown changes nothing: with no slip, routing behaves as it did
  before slips (the queue rule).
- **R4** A box that is only busy with its own jobs is never refused.
- **R5** Nothing is handed to the owner as a task. What the code cannot do
  itself is stated as a fact in a finding, once.

**Boundary of R2.** Platform-provided runtime context (`GITHUB_*`,
`RUNNER_*`, `GITHUB_TOKEN`), credentials, and settings unrelated to routing
(build, test, telemetry) are not routing information. Everything that
chooses a runner label, a tier, a pool, a slot split, a limit or a reporter
is.

## Decision

1. **The routing slip.** The box relay (the mesh leader) writes its current
   routing answer for a repository as a `RoutingSlip`
   (`packages/ci-gh-actions/data-models/routing_slip.proto`): `version` 1,
   the lower-case `repository`, `issuedAt` and `expiresAt` by the relay's
   clock (ten minutes apart), one route per class `pr`, `fork` and `trunk`
   (`runner`, `tier` = `fleet`/`local`/`github`, `reason` = `fleet-open`,
   `fleet-busy`, `no-node`, `no-capacity`, `stalled` or `pinned`), and the
   writing relay's `nodeId` and `commit`. A reason is a code, never a figure,
   and agrees with the tier: the fleet is open or busy (busy is never
   refusal), anything else is refused; `pinned` goes with any tier.
2. **Where it lives.** `refs/hobo/routing-slip` points at a parentless commit
   whose tree is a one-file tree (created once and reused) and whose message
   is the slip's JSON. The relay writes with `POST /git/commits` and
   `PATCH /git/refs/hobo/routing-slip` (`force: true`; `POST /git/refs` the
   first time), which the App's `contents: write` allows. The route job reads
   with its own token and `contents: read`: `GET /git/ref/hobo/routing-slip`,
   then `GET /git/commits/<sha>`, within three seconds.
3. **When a slip is used.** Only when it has not expired by the reader's
   clock, names the reader's repository, and every runner it names is one of
   the committed `runnerRouting.labels`. Anything else (no slip, an expired
   or malformed one, another repository, an unknown label, a read error or
   timeout) is no slip, and the queue rule decides as it does today. No
   signature: the keys a reader could trust would have to be committed by a
   person. Only holders of `contents: write` can move the ref, and the label
   allowlist bounds what a forged slip can do.
4. **Committed policy.** `.hobo/ci.json` gains `runnerRouting`: the pin,
   queue limits, the four labels, whether a local box is enrolled, the main
   gate's parallel cap, the verdict hysteresis and stall limit, the box's
   slot split and admission, external pools, and the repository variables
   the relay retires. Its values are the code's defaults, so committing them
   changed nothing. It is parsed by zod (`src/runner-routing.ts`,
   `parseCiRunnerRouting` in `src/relay-routing.ts`), described by the
   editor schema and `#RunnerRouting`, and read without dependencies by
   `scripts/ci/runner-routing.mts` in the route job's sparse checkout.
5. **How the relay decides**, per class, from what only it holds: it refuses
   the fleet (`tier: github`) when no live node serves the class's label
   (`no-node`); when every node refuses for a reason other than its own
   running jobs, critical host or storage health included whether or not
   the node is busy, and no external pool has a free runner (`no-capacity`);
   or when work assigned to the label has not started for
   `runnerRouting.verdict.stallMs` (`stalled`). Otherwise the fleet label,
   `fleet-open`, or `fleet-busy` when every slot is taken (R4). A local box
   enrolled by committed config takes the place of GitHub-hosted when the
   fleet is refused; a committed `runnerRouting.pin` is written into every
   class (`pinned`); forks use `classes.fork`, never the trunk label. An
   external pool counts as free only when it can be counted (repository
   runners with its label, not busy); one that cannot be counted never
   allows a refusal (R3). The existing evaluator and its enter/exit
   hysteresis are reused.
6. **Nothing routes through a variable.** The routing list below names
   every one that counts as routing. Platform context (`GITHUB_*`,
   `RUNNER_*`), credentials and settings unrelated to routing are not
   routing.

### Routing list {#adr-0181-routing-list}

Exhaustively: `HOBO_CI_ROUTE`, `HOBO_CI_ROUTE_MAX_WAIT_SECONDS`,
`HOBO_CI_ROUTE_MAX_QUEUED`, `HOBO_CI_TRUNK_RUNNER`, `HOBO_CI_LOCAL_RUNNER`
(the repository variable; not `scripts/local-runner.ts`'s switch),
`HOBO_CI_INCLUDE_OWN_RUN`, `HOBO_CI_ATTESTED`, `HOBO_CI_FLEET_ROUTES`,
`HOBO_CI_FLEET_VERDICT_*`, `HOBO_CI_FLEET_REPORTER_ID`,
`HOBO_CI_FLEET_EXTERNAL_POOLS_JSON`, `HOBO_CI_FLEET_REPORTERS_JSON`,
`HOBO_CI_FLEET_CAPACITY_VOLATILITY_MB`, `HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS`,
`HOBO_CI_WORKER_SLOTS`, `HOBO_CI_WORKER_TRUNK_SLOTS`,
`HOBO_CI_WORKER_TRUNK_LEND`, `HOBO_CI_WORKER_PR_CAP_WITH_TRUNK`,
`HOBO_CI_WORKER_MERGE_GROUP_LEASES`, `HOBO_CI_JOB_ADMISSION`,
`MAIN_WORKSPACE_PARALLEL_CAP`, `HOBO_CI_BOX_RUNNER` (now
`runnerRouting.boxRunner` and `runnerRouting.labels.box`: whether a pull
request's deps-image job asks for the box's own label, which the route job
outputs as `box_runner`), `HOBO_CI_MAIN_REUSE_MERGE_QUEUE` (now
`runnerRouting.mainGate.reuseMergeQueue`, read by
`scripts/ci/merge-queue-reuse.mts` from the route job's checkout), and the
pool label and providers carried by `HOBO_CI_CONFIG`/`HOBO_CI_CONFIG_JSON`
(the daemon takes labels and providers from `.hobo/ci.json` instead; those
two keep only what is not routing). Each of these repository variables is
listed in `runnerRouting.retiredVariables`, which the relay deletes.

Not routing: `HOBO_CI_RELAY_URL` names a relay and is written as a literal by
onboarding; `HOBO_CI_MERGE_QUEUE_BRANCH` names a branch, not a runner. The
shared Turborepo cache's address (formerly the repository variable
`HOBO_CI_TURBO_API`) is not routing either, but no workflow takes a
`vars.HOBO_CI_*` at all: it is committed as `turboCache.api` in
`.hobo/ci.json`, which `.github/actions/turbo-cache` reads from the checkout
inside its step. Moving it changes who can set it from repository admins to
anyone who can change `.hobo/ci.json` on a branch that runs CI with secrets;
those already change the workflows, so no one gains the cache token, and fork
pull requests never receive it.

## Considered and rejected

| Candidate | Why not |
| --- | --- |
| Keep the hosted relay's verdict read (ADR-0180) | Two hops, one of them down in production; a box reports to a service it does not run |
| A check run or commit status per run | The App holds neither `checks` nor `statuses`; it would show in the pull request's checks and could be taken for a required check |
| A ref per run (`refs/hobo/slips/<run_id>`) | One write per run against GitHub's 80-per-minute content-creation limit, shared with the box's job polling, and a cleanup per run. One slip per repository is rewritten only when the answer changes and as a heartbeat |
| Repository variables | The ruling (R2), and the job token cannot read them through the API |
| A signed slip | Whatever key a reader trusts must be committed by a person (R5). The label allowlist and the ten-minute expiry bound a forged slip instead |

## Consequences

- **The hosted relay leaves the routing path.** Its verdict routes, stores,
  reporter enrollment and PACT are removed (delivery layer 04); the
  evaluator stays and feeds slips.
- **Unknown changes nothing.** With the box down, not restarted onto new
  code, or with no mesh leader, there is no slip or an expired one, and the
  route job behaves exactly as today.
- **The box takes the new code after one restart** (finding 149); from then
  on it keeps itself current: every three hours, only while idle, the leader
  prepares main's head in a separate worktree, runs a self-check, and
  re-executes in place only when that passes (delivery layer 05).
- **Write budget.** At most two writes per change, about 40 an hour steady,
  hard-capped at 20 a minute and 300 an hour, with a ten-minute back-off on
  403 or 429.

## Not built

Delivered as one linear stack, each layer on the one below: 02 the route job
reading slip and policy, the workflow and lint changes; 03 the box's slip
writer and decision, variable retirement; 04 the hosted relay's retirement;
05 self-update, the docs and a source guard over the routing list.

## Measurable outcomes {#adr-0181-outcomes}

| Id | Outcome | Check |
| --- | --- | --- |
| M1 | No `vars.HOBO_CI_*` in `.github/` or `packages/ci-gh-actions/templates/` | lint-actions test |
| M2 | No `process.env` read of any name on the routing list in `scripts/`, `packages/ci*` | source guard test |
| M3 | A valid slip decides; the route job adds at most 3 s; no slip adds no wait | route-runner tests with a fake GitHub API |
| M4 | An expired, malformed, wrong-repository or unknown-label slip is never used | reader tests, invalid fixtures |
| M5 | No slip gives the same outputs as before slips on the recorded production cases | route-runner replay tests |
| M6 | Busy and healthy is `fleet-busy`; busy with critical disk is refused; assigned with nothing started for 10 minutes is `stalled` | evaluator and issuer tests |
| M7 | Slip writes stay at or under 20 a minute and 300 an hour under a 100-run burst; one writer per mesh | issuer test with a fake clock |
| M8 | Committed `runnerRouting` values equal the code's defaults | policy test |
| M9 | Variable retirement: 204 and 404 succeed, 403 is logged once, nothing throws | unit test |
| M10 | Self-update never re-executes onto a head whose preparation failed; re-execution keeps the PID and adopts containers | daemon test |
| M11 | The hosted relay has no `/v1/fleet/` route and starts with retired keys present | tests and codegen check |
| M12 | Every layer: script tests, actions lint, architecture guard, codegen, schema, docs freshness, and build, typecheck, lint and test of touched packages | CI |

## Contracts and gates

- **Protobuf:** `routing_slip.proto` (`RoutingSlip`, `RoutingSlipClass`,
  `RoutingSlipRelay`); generated `src/_generated/routing_slip_pb.ts`
  (`pnpm run codegen:check`).
- **CUE:** `#RoutingSlip` and `#RunnerRouting` in
  `data-models/onboarding.cue`, with valid and invalid fixtures (an expired
  slip, a wrong repository, an unknown class, a figure in a reason, a
  generic label, a tier its reason disagrees with; a generic policy label, a
  trunk split with no shared slot) (`pnpm test:schema`).
- **Parse, don't validate:** `src/routing-slip.ts`: `judgeRoutingSlip` turns
  text into a `ParsedRoutingSlip` or the reason it is none
  (`malformed`, `wrong-repository`, `label-not-allowed`, `expired`);
  `routingSlipJson` writes the commit message and refuses what no reader
  would use. `scripts/ci/runner-routing.mts` holds the same rules with Node's
  built-ins only; `scripts/test/runner-routing.test.ts` holds the reader,
  zod and protobuf to the same answer on every fixture (M4) and the
  committed policy to the code's defaults (M8).
- **Git Data API:** `scripts/ci/routing-slip-probe.mts` (read-only by
  default; `--write` touches only `refs/hobo/routing-slip-probe`);
  `scripts/test/routing-slip-probe.test.ts` replays recorded GitHub answers.
- **PACT:** none. The route job and the box meet at a git ref through
  GitHub's API, not at a service boundary of HoBo's.
