---
type: Architecture Decision Record
title: "The Box Relay Hands Each Run Its Route on a Routing Slip"
description: "The box relay writes its routing answer for a repository as a routing slip, the message of a parentless commit at refs/hobo/routing-slip, which the route job reads with its own token. Routing policy is committed in .hobo/ci.json. No environment variable or repository variable carries routing; the hosted relay's verdict path is retired."
tags: [hobo, design, adr, ci, relay, routing, fleet]
---

# ADR-0181 — The Box Relay Hands Each Run Its Route on a Routing Slip {#adr-0181}

**Status:** Accepted. Built
([plan 0026](../../plans/0026-relay-routing-slips.md), layers 01–04): the
record (`RoutingSlip`), its parsers and writer, the committed policy
(`runnerRouting`), the dependency-free reader and the Git Data API probe
(01); the route job reading slip and policy, and the workflows (02); the
box's slip writer and decision, and variable retirement (03); the hosted
relay's verdict path retired (04: no `/v1/fleet/` route, retired runtime
config keys accepted and ignored). Not built: self-update (layer 05, "Not
built" below).
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
(plan 0026, R1–R5): the relay decides; no environment or repository variable
carries routing; unknown changes nothing; a box busy with its own jobs is
never refused; nothing is handed to the owner as a task.

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
5. **Nothing routes through a variable.** Plan 0026 3.4 lists every name
   that counts as routing. Platform context (`GITHUB_*`, `RUNNER_*`),
   credentials and settings unrelated to routing are not routing.

## Considered and rejected

| Candidate | Why not |
| --- | --- |
| Keep the hosted relay's verdict read (ADR-0180) | Two hops, one of them down in production; a box reports to a service it does not run |
| A check run or commit status per run | The App holds neither `checks` nor `statuses`; it would show in the pull request's checks and could be taken for a required check |
| A ref per run (`refs/hobo/slips/<run_id>`) | One write per run against GitHub's 80-per-minute content-creation limit, shared with the box's job polling, and a cleanup per run. One slip per repository is rewritten only when the answer changes and as a heartbeat |
| Repository variables | The ruling (R2), and the job token cannot read them through the API |
| A signed slip | Whatever key a reader trusts must be committed by a person (R5). The label allowlist and the ten-minute expiry bound a forged slip instead |

## Consequences

- **The hosted relay leaves the routing path.** Its verdict routes
  (`GET`/`PUT /v1/fleet/verdicts/{owner}/{repo}`,
  `GET /v1/fleet/reporters/{owner}/{repo}`, now 404), stores, reporter
  enrollment and signature, the box's reporter, `fleet_verdict.proto` and
  the `fleet-verdict-boundary` PACT are removed (plan 0026 layer 04). Its
  runtime config reserves the three retired fields, and its loader drops
  `HOBO_CI_FLEET_REPORTERS_JSON`, `HOBO_CI_FLEET_VERDICT_SERVING` and
  `HOBO_CI_FLEET_VERDICT_DAILY_BLOCK_MINUTES` before parsing, so a store
  that still holds one starts the relay. `relay-deploy.yml` smoke-checks
  `/healthz` only, and the CI health monitor asks no relay. The evaluator
  stays and feeds slips.
- **Unknown changes nothing.** With the box down, not restarted onto new
  code, or with no mesh leader, there is no slip or an expired one, and the
  route job behaves exactly as today.
- **The box takes the new code after one restart** (finding 149); from then
  on it keeps itself current (plan 0026, 3.8).
- **Write budget.** At most two writes per change, about 40 an hour steady,
  hard-capped at 20 a minute and 300 an hour, with a ten-minute back-off on
  403 or 429.

## Not built

Plan 0026 layer 05: self-update, the remaining runbook updates, the
`no routing slip` monitor signal's documentation and the source guard over
3.4's list.

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
