---
type: Implementation Plan
title: "Relay-owned runner routing: one-shot delivery plan"
description: "Complete design and swarm handoff for making the relay the only judge of whether the fleet can take a run: the verdict reporter, signed reports, main-gate routing, loud fallbacks, retirement of the variable channels, and the measures that prove it works."
tags: [hobo, ci, relay, routing, fleet, resilience, implementation, sdlc]
---

# Relay-owned runner routing: one-shot delivery plan

**Status:** draft. An adversarial review and an implementer walk-through of this document are in progress; do not dispatch from it until this line says ready.
**Design authority:** [ADR-0180](../design/adr/fleet-verdict.md#adr-0180). This plan completes it and amends it in layer 02.
**Base of the stack:** `claude/relay-fleet-verdict` ([#1952](https://github.com/Hobo-Labs/HoBo/pull/1952)), which sits on `claude/fervent-fermat-4dj3il` ([#1943](https://github.com/Hobo-Labs/HoBo/pull/1943)). If both have merged, base on `main`.

This is one delivery, not a sequence of phases. Every layer below ships in the same stack. The only staged thing is **enablement** (section 6.10): the code lands switched off, and switches on when measured evidence allows.

## 1. How to use this document

- **Coordinator (parent session):** run the repo's `sdlc` protocol. Create one issue per layer in section 9 from its one-shot body, dispatch implementers into worktrees, keep the stack with `gh stack`, and own every file marked *coordinator* in section 9.2. Record the chain in `docs/plans/relay-owned-runner-routing/sdlc-state.md` before dispatch.
- **Implementers:** build exactly one layer. Red test, minimal fix, commit; `pnpm agent:check -- --staged` before every commit; conventional commits; several commits per layer. Never edit a file another layer owns; report it as a `cascadeDelta`. Hand back `.sdlc/report.json`.
- **Reviewers:** check a layer against its acceptance list and against the failure table (section 7): every row assigned to the layer must have a named, passing test.
- A layer is done under the stack-aware Done rule in `.claude/skills/sdlc/references/stacked-prs.md`, plus: each measurable outcome it owns (section 8) is demonstrated.

## 2. Problem

Three incidents on 2026-11-12, one cause each, one shared pattern.

| Incident | Evidence | Cause |
| --- | --- | --- |
| A main run was sent to a fleet that could not admit its jobs; shards started 14–36 minutes late and two timed out | Run [43207388098](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098), [finding 142](../ci/findings/0142-box-admission-counted-neither-promised-memory-nor-lasting-headroom.md) | Nothing that routes a run can see what the relay knows. Main shards are not routed at all: they are pinned to `hobo-trunk` |
| Every unpinned run of four workflows went to paid runners | Run [43239493135](https://github.com/Hobo-Labs/HoBo/actions/runs/43239493135), [finding 143](../ci/findings/0143-route-job-read-a-capacity-record-no-worker-wrote.md) | The route script crashed on an import the workflow did not check out, and the step fell back with a warning nobody read |
| The shard planner has used its default cap on every run checked | Jobs `131146352582`, `131259868933`: `variables/HOBO_CI_FLEET_CAPACITY returned 403` | A job token cannot read a repository variable; the failure is swallowed |

**The shared pattern:** a channel between the relay and a workflow was built on both sides, unit-tested on both sides, never seen carrying a value in production, and failed into a default without anyone being told. A broken script test also went unnoticed on [#1943](https://github.com/Hobo-Labs/HoBo/pull/1943) because the pull-request lanes that ran do not include `scripts/test`.

## 3. Goals, non-goals, owner rules

**Goals**

1. A run is not sent to the fleet while the fleet cannot take it for a reason waiting will not fix, and is not sent to paid runners because the fleet is merely busy.
2. The relay is the only component that judges the fleet. Workflows ask and obey.
3. Every fallback to a default is recorded where a monitor reads it, and a monitor fails within hours when a signal has been in fallback.
4. One channel between relay and workflows. The repository-variable channels are removed.
5. Paid overflow caused by a verdict is bounded.

**Non-goals**

- A relay ledger of GitHub-hosted spend. GitHub's billing is the system of record and its budget is the hard cap (section 6.8). The hosted relay keeps no durable state ([ADR-0179](../design/adr/hosted-relay-stateless.md#adr-0179)), so a counter in its cache cannot be a ledger.
- Routing individual jobs. A run is routed once, and its main shards once more just before they queue.
- Installing or resizing ARC, or changing what else runs on the box. Section 10 asks the owner for those facts.

**Owner rules (binding on every layer)**

- R1. Capacity is the relay's concern. No workflow, script or action computes whether the fleet can take work from capacity figures.
- R2. Nothing about the fleet reaches a workflow through a repository variable, an action input or an environment variable. A workflow learns it by asking the relay at the time it decides.
- R3. A signal that is missing, stale or unreadable is unknown. Unknown never moves a run to paid runners.
- R4. A fleet that is only busy with its own jobs is not blocked.

## 4. Verified facts the design rests on

| Fact | Where |
| --- | --- |
| The box worker daemon runs the relay core, admits by polling GitHub, and has no HTTP listener, no public URL and no credential for the hosted relay | `packages/ci-gh-actions/scripts/isolated-worker-daemon-main.mts:272-276,945` |
| Memory admission is mutating; there is no way to ask "would a standard job fit". The pure pieces are `hostMemoryAdmitFits`, `hostPressureBlocksAdmission`, `memoryAdmitHeadroom` | `src/isolated-worker/memory-admission.ts:347`, `host-resource-pressure.ts:267,300` |
| The daemon does not read the live memory of its running containers; it reads `memory.peak` once, when a container stops | `cli-docker-driver.ts:524`, `container-controller.ts:1954` |
| `MemAvailable` is host-wide, so it falls when the box's own jobs use memory. Admission compares `MemAvailable − committed − request` with reserve plus volatility | `memory-admission.ts:418-438` |
| There is no mesh unless `HOBO_CI_NATS_URL` is set. ARC is never a mesh node; "arc free slots" in the daemon means "mesh minus this box" | `mesh-worker.ts:75`, daemon `:855-862` |
| ARC runners in production take jobs on the fleet labels themselves (`hobo-runner-*` with label `hobo`). The poller ingests a fleet-label job with a foreign `runner_name` and returns `foreign-runner`; it keeps no count | Run 43207388098; `hosted-relay.ts:976-982`; `github-job-poller.ts:472` |
| Main-gate jobs are not routed: `main-gate-plan` and `main_workspace_tests` use a fixed `hobo-trunk` expression | `.github/workflows/hobo-ci.yml:876,1173` |
| The relay's HTTP layer, its control plane, the in-memory and cache verdict stores, and the route job's client exist; the read is open, the write takes an account bearer | [#1952](https://github.com/Hobo-Labs/HoBo/pull/1952) |
| Nodes have an Ed25519 identity key, created on first start, never leaving the node | `docs/design/ci-relay-mesh.md` ("Trust"), `src/mesh-node.ts` |
| `createGithubOidcVerifier` accepts only `workflow_dispatch` tokens and is used only for the runner claim | `src/oidc.ts:5-18` |
| The relay deploy has no rollback and its smoke check reads only `/healthz` and `/readyz` | `.github/workflows/relay-deploy.yml:178-202` |
| No workflow monitors CI health, opens issues or reads annotations | `.github/workflows/` |
| No shared retry, back-off or circuit-breaker helper exists in the relay packages | `packages/ci-gh-actions/src`, `packages/core` |
| On this container `pnpm run test:scripts` fails 8 tests on `main`; whether it fails on the CI image is unknown | Measured 2026-11-12 |

## 5. Architecture in one picture

```text
box relay (decides)                 hosted relay (keeps, serves)            workflows (ask, obey)
┌───────────────────────────┐      ┌───────────────────────────────┐      ┌─────────────────────────────┐
│ evaluator (pure, 10 s)    │      │ PUT /v1/fleet/verdicts/o/r    │      │ Route runners job           │
│  external memory headroom │ sign │  verify Ed25519, sequence,    │ GET  │  queue heuristics           │
│  storage critical         ├─────►│  enrolled reporter → account  │◄─────┤  + relay verdict (3 s)      │
│  declared pools, mesh     │      │  one entry per reporter, TTL  │      │  → runner for the run       │
│ state machine (hold, ttl) │      │ GET  …/verdicts/o/r  (open)   │      │ main-gate-plan              │
│ block allowance (per day) │      │  blocked iff every live       │◄─────┤  asks again before shards   │
│ reporter (off tick,       │      │  reporter blocks; 5 s CDN     │      │  → runner for the shards    │
│  timeout, back-off,       │      │ GET  …/reporters/o/r (OIDC)   │◄─────┤ ci-health (every 2 h)       │
│  breaker)                 │      │  liveness, shadow verdicts    │      │  reads annotations + status │
└───────────────────────────┘      └───────────────────────────────┘      └─────────────────────────────┘
```

## 6. Design

### 6.1 What "blocked" means (the evaluator)

A pure function in the relay, sampled every 10 seconds by the reporter. It must not call `admit`, `availableLowWaterMb` or anything else that changes admission state.

A fleet label is **blocked** when both hold:

1. **This box cannot take a job for a reason other than its own jobs.** Either:
   - **External memory.** Let `ownWorkingSetMb` be the sum, over this box's running job containers, of cgroup v2 `memory.current − memory.stat:inactive_file` (reclaimable file cache is already in `MemAvailable`). Let `externalFreeMb` be the lowest `MemAvailable + ownWorkingSetMb` over the last 60 seconds. The box is externally blocked when `externalFreeMb − standardClassMb < reserveMb + volatilityMb`. With no jobs running this is exactly admission's own headroom test. A container whose cgroup cannot be read contributes its lease's reservation instead, and the sample is marked `estimated`.
   - **Storage.** The host health monitor's current verdict is `critical` for a disk or inode reason. Load and CPU pressure are not reasons: the box's own jobs cause them.
2. **Nothing else can take it.** Every other pool that serves the label has no free slot:
   - **Mesh peers**, when there is a mesh: no other live healthy node serving the label advertises a free slot.
   - **Declared external pools** (ARC): for each pool in `HOBO_CI_FLEET_EXTERNAL_POOLS_JSON` whose `labels` include the label, `maxRunners − busy ≤ 0`, where `busy` is the number of in-progress jobs on those labels whose `runner_name` starts with the pool's `runnerNamePrefix`, counted from the job lists the poller already reads.
   - **Undeclared runners.** If a job on the label was taken in the last 15 minutes by a runner that is neither this box's nor a declared pool's nor a mesh peer's, capacity exists that the relay cannot account for. The label is then never `no-capacity` (R3), and the relay logs `hobo_ci_fleet_verdict_unaccounted_runner` once per runner prefix per hour.

Reasons: `no-capacity` as above. `no-node` only from a mesh board: no live healthy node serves the label. A box without a mesh never reports `no-node`.

A box whose slots are all in use but which passes the external-memory test is busy, not blocked (R4).

### 6.2 State machine, lifetime, allowance

| Rule | Value | Setting |
| --- | --- | --- |
| Sample interval | 10 s | fixed |
| Enter blocked | every sample blocked for 60 s | `HOBO_CI_FLEET_VERDICT_ENTER_MS` |
| Leave blocked | every sample clear for 30 s | `HOBO_CI_FLEET_VERDICT_EXIT_MS` |
| Report on change | immediately | — |
| Heartbeat, state unchanged, including "nothing blocked" | every 60 s | fixed |
| Lifetime of a report | 180 s | fixed, under the relay's 300 s limit |
| Daily block allowance | 240 minutes of blocked time per label per UTC day; once spent, the label is reported clear until the next day and `hobo_ci_fleet_verdict_allowance_spent` is logged | `HOBO_CI_FLEET_VERDICT_DAILY_BLOCK_MINUTES` |

The allowance bounds paid overflow that a verdict can cause when the fleet is stuck blocked (goal 5). It is kept in a small file beside the journal so a restart does not reset it. On drain or shutdown the reporter sends one last report that blocks nothing; if it cannot, the report lapses in 180 seconds.

Modes, set on the box with `HOBO_CI_FLEET_VERDICT`: `off` (default; nothing runs), `shadow` (evaluates, logs, reports with `mode: "shadow"`; the relay keeps it and does not serve it), `report`.

### 6.3 Reporting (box relay → hosted relay)

- **Off the dispatch tick.** The reporter runs on its own unreferenced timer, as the mesh beat does. Nothing in admission, dispatch or the poller awaits it. Its memory reads are bounded to 2 seconds in total per sample; a slow read marks the sample `estimated`.
- **Signed, not bearer.** A report is signed with the node's Ed25519 identity key (the key `createMeshNode` uses; created on first start when there is no mesh). Headers: `X-HoBo-Reporter: <node id>`, `X-HoBo-Sequence: <integer>`, `X-HoBo-Issued-At: <RFC 3339>`, `X-HoBo-Signature: ed25519=<base64url>` over `v1\n PUT\n <lower-case path>\n <sha256 of body, hex>\n <issued-at>\n <sequence>`. No secret is sent, and the key can do nothing but sign reports (ADR-0027). The account-bearer write from #1952 is removed.
- **Timeout, back-off, breaker.** Each PUT has a 3-second limit. A failure retries with back-off 5, 10, 20, 40, 80 seconds, each ±20% jitter. After 5 consecutive failures the breaker opens for 5 minutes, then lets one probe through. `401`, `403` and `400` are not retried within the same state: they mean enrollment, clock or contract is wrong, and are logged as `hobo_ci_fleet_verdict_report_rejected` with the relay's reason. A report that is not delivered simply lapses, which is the safe direction (R3).
- **Sequence.** Monotonic per reporter, starting from the current time in milliseconds at process start, so a restart never reuses one.
- **Settings on the box:** `HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN` (https; required when the mode is not `off`), `HOBO_CI_FLEET_EXTERNAL_POOLS_JSON` (`[{"labels":["hobo","hobo-trunk"],"runnerNamePrefix":"hobo-runner-","maxRunners":1}]`), and the settings in 6.2. An invalid value refuses to start, as other daemon settings do.

### 6.4 Keeping and serving (hosted relay, and the Node host)

- **Enrollment.** Runtime configuration lists reporters: `HOBO_CI_FLEET_REPORTERS_JSON` = `{"reporters":[{"id","publicKey","accountId"}]}`, at most 8 per account, public keys only. A report is accepted when its reporter is enrolled, the signature verifies, `issued-at` is within 300 seconds of the relay's clock, the sequence is higher than the last accepted from that reporter for that repository, and the repository is connected under the reporter's account. Otherwise `401` with a `reason` (`unknown-reporter`, `bad-signature`, `clock-skew`, `replayed`) or `404` when the repository is not the account's.
- **One entry per reporter.** Stored at `fleet-verdict:<owner>/<repo>:<reporter id>` with a time to live ending at `expiresAt`. The last accepted sequence is stored with it.
- **Agreement rule.** A label is blocked in the served verdict only when at least one `report`-mode entry is live and **every** live `report`-mode entry blocks it. The reason is `no-node` only if all say `no-node`, else `no-capacity`. A partitioned or wrong reporter therefore cannot block a label on its own while another reporter is alive and says it is open.
- **Kill switch.** Runtime configuration `HOBO_CI_FLEET_VERDICTS=off` makes the read answer "nothing blocked" and the write answer `503`.
- **Read.** `GET /v1/fleet/verdicts/{owner}/{repo}`: unchanged shape, still open, still the same answer for an unknown repository, still no store read for an unconnected one. `Cache-Control` becomes `public, s-maxage=5, max-age=0` so the platform's cache absorbs repeated asks; the five seconds are in the lag budget.
- **Status.** `GET /v1/fleet/reporters/{owner}/{repo}`, authenticated by a GitHub Actions OIDC token whose audience is the relay's origin and whose `repository` is the path's repository, from any event. It answers, per enrolled reporter: `id`, `mode`, `lastReportAt`, `expiresAt`, the labels it blocks, and `rejected` (count and last reason in the past hour). This is what the health monitor and the enablement gates read. It needs a second verifier (`createGithubWorkflowVerifier`); the runner-claim verifier is left exactly as it is.
- **Boundary declaration (ADR-0136).** The report boundary declares `EffectSpec { purity: "varies", domains: ["network","externalCall","clock"] }` and a `ResilienceProfile` with the timeout, retry and circuit-breaker of 6.3 and `neverRetry` for the rejections.

### 6.5 Workflows: route once, re-ask before shards

- **Route job.** As in #1952, plus one annotation per decision: `::notice title=hobo-ci-route::{"v":1,"tier":…,"runner":…,"relay":"verdict"|"unanswered"|"unasked","why":…,"blockedBy":…}`. The action's fallback path emits `::warning title=hobo-ci-route-fallback::<reason>`. These are the only record the health monitor needs, and they contain the job's decision, not fleet facts.
- **Main gate is routed.** `main-gate-plan`, `main-gate` and `main_workspace_tests` stop using the fixed trunk expression. The plan job uses the run's route. Just before it emits the shard list it runs the route decision again (`route-runner.mts`, same rules, same relay) and outputs `shard_runner`; the shard jobs use that. The second decision is not cached with the plan. This closes the gap in finding 142, where shards queued eight minutes after the run started.
- **No capacity reader.** `scripts/ci/load-fleet-capacity.mts` loses its API read and its `HOBO_CI_FLEET_CAPACITY_JSON` input. The shard cap is `MAIN_WORKSPACE_PARALLEL_CAP` when set, else 8 on GitHub-hosted runners and 4 on the fleet.
- **Lint.** `scripts/lint-actions.ts` rejects any workflow or action that mentions `vars.HOBO_CI_FLEET_` or an input or environment name beginning `fleet-` / `HOBO_CI_FLEET_` (R2).
- **Scripts lane.** `pnpm run test:scripts` becomes a pull-request gate for changes under `scripts/**`, `test/**` and `.github/**`.

### 6.6 Loud fallbacks: the CI health monitor

`.github/workflows/ci-health.yml`, every two hours and on demand, on `ubuntu-24.04`, permissions `actions: read`, `checks: read`, `issues: write`, `id-token: write`. It runs `scripts/ci/ci-health.mts` (no packages), which reads the last 24 hours of runs, their jobs, the route annotations, and the relay's status route. It fails, and opens or updates one issue per signal labelled `ci-health`, when:

| Signal | Breach |
| --- | --- |
| H1 routing did not run (`hobo-ci-route-fallback`) | any occurrence |
| H2 relay asked and gave no verdict | more than 5% of asks over at least 20, or all of at least 5 |
| H3 a routed workflow did not ask (`unasked`) while `.hobo/ci.json` names a relay and the tier is not pinned | any occurrence |
| H4 no live reporter while the box mode is `report` or `shadow` (from the status route) | longer than 10 minutes |
| H5 reports rejected | any in the past hour |
| H6 stall: a run routed to the fleet had a job queued on a fleet label for more than 10 minutes while no verdict blocked that label | any occurrence |
| H7 false block: a run moved off the fleet by a verdict, while a job on that label started within 120 seconds of the decision | more than 20% of at least 5 such runs |
| H8 paid minutes on GitHub-hosted runners in routed workflows | above `CI_HEALTH_PAID_MINUTES_DAILY` (default 300) |
| H9 the monitor could not read its inputs | two consecutive runs |

An issue closes itself when its signal has been clear for 24 hours. H6 is the detector for finding 142; H1 for finding 143.

### 6.7 Retirement (one channel)

Removed in this delivery: the `HOBO_CI_FLEET_STATE` publisher and its record, the `HOBO_CI_FLEET_CAPACITY` publisher and its record, and the `HOBO_CI_FLEET_ROUTES` variable publisher (the pure `fleetRouteTable` stays; nothing reads the variable, and R2 forbids reading it). With them goes `writeRepositoryVariable`, the `HOBO_CI_FLEET_ROUTES` daemon flag, and the App's need for **Variables: write**. The owner deletes the three variables and may drop the permission (section 10).

### 6.8 Bounding cost

1. **Hard cap:** a GitHub Actions budget on the organization or repository, set by the owner. GitHub stops hosted jobs when it is spent.
2. **Relay-owned bound:** the daily block allowance (6.2).
3. **Visibility:** health signal H8.
4. **Operator override:** `HOBO_CI_ROUTE=fleet` pins every run to the fleet and asks no one; `HOBO_CI_FLEET_VERDICTS=off` silences the relay.

Cost when a verdict fires on a main push: the full gate and up to 8 shards run on GitHub-hosted runners, on the order of 100 billed minutes.

### 6.9 Operations

- **Deploy order.** Hosted relay first, then boxes, then the workflows that depend on new answers. Readers ignore fields they do not know; the relay refuses reports it does not fully understand, and H5 reports that within two hours.
- **Smoke check.** `relay-deploy.yml` fails the deploy when `GET /v1/fleet/verdicts/<this repository>` is not `200` with a `repository` and a `blocked` object, or the status route does not answer `200` to its own OIDC token.
- **Rollback.** Revert the commit on `main`; Vercel deploys the previous code. Because every consumer treats a relay that does not answer as unknown, a bad relay degrades routing to today's behaviour and never stops a run. The runbook goes in `packages/ci-vercel/README.md`.
- **Capacity itself.** Job containers accept `HOBO_CI_WORKER_CGROUP_PARENT`, so the owner can place CI under a slice with protected memory and cap other workloads. The runbook states the values for a 16 GiB box. This reduces how often the box is externally blocked; routing only decides who pays when it is.
- **Logs.** New events: `hobo_ci_fleet_verdict_state` (label, blocked, reason, external free, own working set, estimated, peers and pools free), `…_reported`, `…_report_failed`, `…_report_rejected`, `…_allowance_spent`, `…_unaccounted_runner`, and on the relay `hobo_ci_fleet_verdict_kept` / `…_refused`. Each is added to `CI_INFRA_EVENT_TYPES` and to the event tables.

### 6.10 Enablement gates

The stack merges with the box mode `off`. Each step needs the evidence named; the health monitor produces all of it.

| Step | Do | Gate to pass before the next step |
| --- | --- | --- |
| E1 | Deploy the hosted relay; smoke check passes | Route jobs log `"relay":"verdict"` on at least 95% of asks over 24 hours (H2 clear) |
| E2 | Enroll the box's key; set mode `shadow` | H4 and H5 clear for 72 hours; shadow verdicts present in the status route |
| E3 | Read the shadow record | Over the 72 hours: shadow false-block rate (H7 computed on shadow verdicts) at most 20%, and at least one shadow block coincides with an H6 stall or there were no stalls |
| E4 | Set mode `report` | For 7 days: H6 zero, H7 within bound, H8 within bound |
| E5 | Delete the three repository variables; drop **Variables: write** | — |

Rollback of any step is its own switch: box mode back to `shadow` or `off`, or `HOBO_CI_FLEET_VERDICTS=off` on the relay.

## 7. Failure scenarios and resiliency

Every row has an owner layer and a test the layer must add. "Unknown" means the consumer behaves as if no relay existed (R3).

| # | Failure | Behaviour | Pattern | Layer / test |
| --- | --- | --- | --- | --- |
| F1 | Hosted relay down, slow, or returns 5xx | Route job: unknown after 3 s, logs why. Reporter: back-off, then breaker | Timeout, fail-open, circuit breaker | 05 `route-relay-down`; 04 `reporter-breaker` |
| F2 | Relay cache lost or unreachable | Read answers 503 → unknown; entries reappear at the next heartbeat (≤ 60 s) | Rebuild from source, TTL | 03 `cache-loss` |
| F3 | Box crashes while a label is blocked | Entry lapses in ≤ 180 s; label opens | Dead-man's switch (TTL) | 04 `crash-while-blocked`; 03 `expiry` |
| F4 | Box drains or restarts | Final clear report; allowance and sequence survive | Graceful shutdown, durable counter | 04 `drain-clears`, `restart-keeps-allowance` |
| F5 | Two reporters disagree (partition, bad host) | Label blocked only if all live reporters block it | Agreement rule, fail-open | 03 `agreement` |
| F6 | Report replayed, or sent twice | Second is refused `replayed`; state unchanged | Idempotence, monotonic sequence | 03 `replay` |
| F7 | Reporter key stolen | Attacker can block only that account's connected repositories, only while it keeps signing; allowance does not apply to a forged report, so H7/H8 and the kill switch are the response. Remove the key from enrollment | Least privilege, revocation | 03 `unenrolled-refused`; runbook |
| F8 | Reporter clock wrong by more than 5 minutes | Reports refused `clock-skew`; H5 fires; routing unknown | Bounded skew, loud rejection | 03 `clock-skew`; 06 `h5` |
| F9 | Memory flaps around the threshold | Enter 60 s, leave 30 s; each run decides once | Hysteresis | 04 `flap` |
| F10 | Fleet stuck blocked for hours | Allowance spent → label reported clear, runs queue, H6 fires | Budget, circuit breaker on spend | 04 `allowance` |
| F11 | Box is busy, not blocked | Not reported | Correct attribution | 04 `busy-not-blocked` |
| F12 | A container's cgroup cannot be read | Reservation used, sample `estimated`, logged | Graceful degradation | 04 `estimated` |
| F13 | ARC present but undeclared | Label never `no-capacity`; logged; H-issue via H6 if stalls follow | Fail-open on unaccounted capacity | 04 `unaccounted` |
| F14 | ARC declared with the wrong size | Too high: under-blocks (stalls, H6). Too low: over-blocks (H7, H8) | Detect by outcome | 06 `h6`, `h7` |
| F15 | Evaluator or reporter throws or hangs | Isolated timer; dispatch tick unaffected; error logged; no report | Bulkhead | 04 `tick-unaffected` |
| F16 | Verdict changes between routing and shard queueing | Plan job asks again | Re-evaluation at the point of use | 05 `plan-recheck` |
| F17 | Relay and box on different versions | Relay refuses what it does not understand (`400`), H5 fires; readers ignore unknown fields | Expand then contract, strict writer / tolerant reader | 02 contract fixtures; 03 `unknown-field` |
| F18 | Route script cannot run (missing file, no Node) | Titled warning; H1 fires within 2 hours | Loud fallback | 05 `fallback-annotated`; 06 `h1` |
| F19 | Open read is hammered | Platform cache serves repeats; unconnected names never touch the store | Caching, cost isolation | 03 `no-store-read-unconnected`, `cache-header` |
| F20 | Fork pull request edits `.hobo/ci.json` | Affects only its own run; no credential is sent | Blast-radius containment | exists in #1952 |
| F21 | Budget spent at GitHub | Hosted jobs fail to start; H8 warned earlier; pin to fleet | Hard cap, operator override | runbook |
| F22 | Health monitor itself broken | H9 after two runs; scheduled-workflow failure notifies | Monitor the monitor | 06 `h9` |
| F23 | Bad relay deploy | Smoke check fails the deploy; consumers unknown; revert | Smoke test, safe rollback | 08 `smoke` |
| F24 | A workflow reintroduces a fleet variable | Lint fails | Guardrail in CI | 05 `lint-fleet-vars` |
| F25 | A script test breaks | Scripts lane fails the pull request | Gate | 01 |

## 8. Measurable outcomes

Each is checked by the named means; the health monitor's run summary prints all that it measures.

| # | Outcome | Target | Measured by | Owner layer |
| --- | --- | --- | --- | --- |
| M1 | Lag from the box becoming externally blocked to a new run avoiding the fleet | p95 ≤ 90 s | `04` integration test with a fake clock (60 s hold + 10 s sample + report) and `05` end-to-end; in production from `…_state` and route annotations | 04, 05 |
| M2 | Lag from recovery to runs returning | p95 ≤ 60 s; ≤ 185 s if the reporter died | same | 04, 03 |
| M3 | Stalls on an unblocked fleet (H6) | 0 in 7 days after E4 | ci-health | 06 |
| M4 | False blocks (H7) | ≤ 20% | ci-health | 06 |
| M5 | Route jobs that got a relay answer | ≥ 99% over 7 days | ci-health (H2) | 05, 06 |
| M6 | Routing fallbacks (H1) | 0 in 30 days | ci-health | 06 |
| M7 | Time for the monitor to raise an injected fault | ≤ 4 hours | game day in section 9.4 | 06 |
| M8 | Added time on the dispatch tick | p99 within 5% of before | `04` benchmark `tick-unaffected` | 04 |
| M9 | Relay read latency | p99 ≤ 300 ms at the origin | `03` test with the cache harness; smoke check prints it | 03 |
| M10 | Workflows that mention a fleet variable or input | 0 | lint (F24) | 05 |
| M11 | Failure rows with a named passing test | 25 of 25 | reviewer checklist | all |
| M12 | Blocked time per label per day | ≤ allowance | `…_allowance_spent` never followed by a blocked report that day; `04` test | 04 |
| M13 | Scripts lane | green on the CI image and required on pull requests | layer 01 | 01 |

## 9. Delivery

### 9.1 The stack

```text
claude/relay-fleet-verdict (#1952)
 └── sdlc/routing-01-scripts-gate        coordinator   independent
  └── sdlc/routing-02-contract           implementer   everything above depends on it
   └── sdlc/routing-03-relay-serve       implementer ┐
    └── sdlc/routing-04-reporter         implementer ├ built in parallel after 02, restacked in this order
     └── sdlc/routing-05-route-main-gate coordinator ┘
      └── sdlc/routing-06-ci-health      implementer + coordinator (workflow file)
       └── sdlc/routing-07-retire        implementer   after 04
        └── sdlc/routing-08-ops-docs     coordinator   last
```

Layers 03, 04 and 05 share no file (9.2) and are developed at the same time in separate worktrees branched from 02. The coordinator adds them to the stack in the order shown and runs `gh stack rebase --upstack` after each. Review and squash-merge go bottom-up, one pull request at a time.

### 9.2 File ownership

A file appears once. An implementer that needs a change in another layer's file reports a `cascadeDelta`.

| Layer | Owns |
| --- | --- |
| 01 | The pull-request lane selection that runs `test:scripts` (the workflow job and `scripts/run-tests.ts` if needed); fixes to failing script tests |
| 02 | `packages/ci-gh-actions/data-models/fleet_verdict.proto`, `onboarding.cue`, `data-models/fixtures/**/fleet-*`, `src/_generated/fleet_verdict_pb.ts`, `contracts/fleet-verdict-boundary.pact.json`, `docs/design/adr/fleet-verdict.md` |
| 03 | `packages/ci-gh-actions/src/fleet-verdict.ts`, `hosted-control.ts`, `http-handler.ts`, `client.ts`, `relay-host.ts`, `relay-cache/records.ts`, new `src/workflow-oidc.ts`, new `src/fleet-verdict-auth.ts`; `packages/ci-vercel/src/fleet-verdict-cache.ts`, `stateless-composition.ts`, `relay-runtime-config-schema.ts`; their tests and `contracts/fleet-verdict-*.test.ts` |
| 04 | New `packages/ci-gh-actions/src/isolated-worker/fleet-verdict-evaluator.ts`, `fleet-verdict-reporter.ts`, `fleet-verdict-state.ts`; `cli-docker-driver.ts`, `github-job-poller.ts`, `cloud-events.ts`; `scripts/isolated-worker-daemon-main.mts`; their tests |
| 05 | `scripts/ci/route-runner.mts`, `plan-main-workspace-shards.mts`, `load-fleet-capacity.mts`, `scripts/lint-actions.ts`, `.github/actions/route-runner/action.yml`, `.github/workflows/hobo-ci.yml` and the other five routed workflows, `scripts/test/**` for these, `test/actions-policy.test.ts` |
| 06 | New `scripts/ci/ci-health.mts` and its test (implementer); new `.github/workflows/ci-health.yml` and its entry in the lint allow-list (coordinator, as a follow-up commit in this layer) |
| 07 | `packages/ci-gh-actions/src/fleet-state.ts`, `fleet-capacity.ts`, `fleet-routes.ts`, `hosted-relay.ts`, `index.ts`, `data-models/mesh.proto`, `mesh-records.ts`; `packages/ci/src/fleet/capacity-input.ts`, `fleet/index.ts`, `data-models/ci.cue`; their tests. Also removes the publisher wiring from the daemon file as a `cascadeDelta` applied on top of 04 |
| 08 | `.github/workflows/relay-deploy.yml`, `packages/ci/RUNNER-QUEUE.md`, `packages/ci-vercel/README.md`, `packages/ci-gh-actions/README.md`, `docs/design/ci-relay-mesh.md`, `ci-fleet-balancing.md`, `traceability.md`, `AGENTS.md`, `.github/pull_request_template.md`, a new finding |

### 9.3 One-shot bodies

Guardrails for every layer: protobuf first with generated types; CUE for every message; one parser at each boundary; PACT for the HTTP boundary; TypeScript only; no new dependency in `route-runner.mts` or `ci-health.mts`; the owner rules R1–R4. Definition of done for every layer: its acceptance commands pass, `pnpm agent:check -- --staged` passed on each commit, docs it invalidates are corrected or reported as a `cascadeDelta` for layer 08, and its rows in sections 7 and 8 are demonstrated.

#### Layer 01: scripts lane is a pull-request gate

- **Why.** A broken test in `scripts/test` reached a green pull request (#1943). F25, M13.
- **Scope in.** Find why `pnpm run test:scripts` fails 8 tests on `main` in a clean container (suites: *workspace test shards on this repository*, *planCommands*, *the repository's own plans*, *main workspace affected-only*, *turbo unit tasks cover the old runner and every root shard input*, *workspace test duration balancing*). Fix the cause; never skip or quarantine. Make the lane run on pull requests that touch `scripts/**`, `test/**` or `.github/**`.
- **Scope out.** Any routing change.
- **Acceptance.** `pnpm run test:scripts` exits 0 on the CI runner image. A pull request that breaks a script test fails the lane (prove with a throwaway branch and say so in the report).

#### Layer 02: contract

- **Why.** Sections 6.3–6.4 change the boundary. Everything else builds on the record.
- **Scope in.** `FleetVerdictReport` gains `mode` (`shadow` | `report`). New `FleetReporterStatus` and `FleetReporterStatusList`. CUE for each; valid and invalid fixtures (an unknown mode, a negative count, a status carrying a key). The Pact: signed-report interactions replace the bearer ones (unsigned → 401, unknown reporter, bad signature, clock skew, replay, another account's repository → 404, accepted, agreement between two reporters, shadow not served), the status route (no token → 401, wrong repository → 403, accepted), and the read's new `Cache-Control`. Amend ADR-0180 with a section for each decision in 6.2–6.4 and 6.7.
- **Scope out.** Any implementation; the provider test will fail until layer 03 and is marked expected-failing in the report, not skipped in code.
- **Acceptance.** `pnpm run codegen:check`, `pnpm test:schema`, `npm run architecture:guard`, `pnpm run docs:design-lint`.

#### Layer 03: relay keeps and serves

- **Why.** Sections 6.4 and 6.9; F2, F5, F6, F7, F8, F17, F19; M2, M9.
- **Steps.** (1) `fleet-verdict-auth.ts`: canonical string, Ed25519 verify with `node:crypto`, skew, sequence. (2) Stores: one entry per reporter; `read` returns the agreed verdict; `status` returns the entries. (3) Enrollment from runtime configuration, validated in `relay-runtime-config-schema.ts`. (4) Routes: signed `PUT`; open `GET` with the cache header; OIDC `GET …/reporters/…` using a new `createGithubWorkflowVerifier` in `workflow-oidc.ts`. (5) Kill switch. (6) Client: remove `putFleetVerdict`'s bearer use; add `getFleetReporters`. (7) Events `hobo_ci_fleet_verdict_kept` / `_refused`.
- **Scope out.** `oidc.ts` and the runner claim; anything under `isolated-worker/`.
- **Acceptance.** `pnpm exec turbo run typecheck test --filter=@hobo/ci-gh-actions --filter=@hobo/ci-vercel`; the Pact provider test passes all interactions over real HTTP; tests named in section 7 for layer 03; a test through `composeStatelessRelay` and one through `createRelayHost` proving the wiring; reads of an unconnected repository cost zero cache commands.

#### Layer 04: evaluator and reporter

- **Why.** Sections 6.1–6.3; F1, F3, F4, F9–F13, F15; M1, M2, M8, M12.
- **Precondition.** #1935 is closed or merged (section 10, P1): this layer edits the daemon file it edits.
- **Steps.** (1) `memoryWorkingSet(containerId)` in `cli-docker-driver.ts` from cgroup v2 `memory.current` and `memory.stat`, bounded in time; `--cgroup-parent` from `HOBO_CI_WORKER_CGROUP_PARENT`. (2) The poller exposes in-progress fleet-label jobs taken by foreign runners (label, runner name, started at) without changing what it ingests. (3) `fleet-verdict-evaluator.ts`: the pure function of 6.1, with its own 60-second window. (4) `fleet-verdict-state.ts`: hold times, heartbeat, allowance file, sequence. (5) `fleet-verdict-reporter.ts`: signing, timeout, back-off, breaker, modes, final clear. (6) Daemon wiring on its own timer; settings validated at start; events added to `cloud-events.ts`.
- **Scope out.** `memory-admission.ts` and admission behaviour: the evaluator reads, it never changes admission. `hosted-relay.ts`.
- **Acceptance.** `pnpm --filter @hobo/ci-gh-actions test`; tests named in section 7 for layer 04, each driven by an injected clock and fake host readings; a property test that for any reading with no running containers the evaluator agrees with `hostMemoryAdmitFits`; an integration test against the layer-03 handler in which a blocked box produces a served verdict within the M1 budget and a recovered one clears within M2; `tick-unaffected` shows dispatch timing unchanged with the reporter hanging.

#### Layer 05: route job and main gate

- **Why.** Section 6.5; F16, F18, F24; M5, M10.
- **Steps.** (1) Route annotations and the titled fallback warning. (2) `main-gate-plan`, `main-gate`, `main_workspace_tests` routed; plan re-decides and outputs `shard_runner`; verify every step of those jobs runs on `ubuntu-24.04` (the preflight's hosted toolchain path). (3) Remove the capacity read from `load-fleet-capacity.mts`; tier-aware cap. (4) Lint rule for fleet variables and inputs; update `ROUTED_RUNS_ON` users and `test/actions-policy.test.ts`. (5) Tests.
- **Scope out.** The reusable-workflow conversion of the route job (rejected, section 12).
- **Acceptance.** `pnpm run test:scripts`, `pnpm run actions:lint`, `pnpm run test:attestation`; a `workflow_dispatch` run of HoBo CI Fabric with `HOBO_CI_ROUTE=github` passes the main gate end to end on GitHub-hosted runners (link the run in the report); `plan-recheck`: with the relay stub blocking between the two decisions, shards get the second answer.

#### Layer 06: CI health monitor

- **Why.** Section 6.6; F14, F18, F22; M3–M7.
- **Steps.** `scripts/ci/ci-health.mts` as pure functions over recorded API pages, plus a thin fetch layer; one issue per signal, opened, updated and closed idempotently; the workflow file.
- **Acceptance.** A test per signal H1–H9 over recorded fixtures, each with a breaching and a clear case; a test that a second run with the same breach updates the same issue; a dry-run mode that prints the report without writing issues, run once against the live repository and attached to the report.

#### Layer 07: retirement

- **Why.** Section 6.7; goal 4.
- **Acceptance.** No reference to `HOBO_CI_FLEET_STATE`, `HOBO_CI_FLEET_CAPACITY` or `HOBO_CI_FLEET_ROUTES` remains outside `docs/ci/findings/` and ADR history; `pnpm exec turbo run typecheck test --filter=@hobo/ci --filter=@hobo/ci-gh-actions`; `pnpm run codegen:check`; the fleet-balancing docs generator still passes.

#### Layer 08: operations and documents

- **Why.** Section 6.9; F21, F23.
- **Scope in.** Smoke check in `relay-deploy.yml`; the rollback, enrollment, kill-switch, cgroup and enablement runbooks; event tables; design docs and traceability; a finding recording the evidence in section 2 and what was measured at each enablement gate; one rule added to `AGENTS.md` and the pull-request template: *a change that adds or alters a channel between two deployed components is not done until one production observation of that channel carrying a value is linked*.
- **Acceptance.** `pnpm run lint:docs`, `docs:design-lint`, `docs:freshness`, `node --import tsx scripts/validate-traceability.ts`, `pnpm run actions:lint`, `scripts/test/relay-deploy-workflow.test.ts`.

### 9.4 Proof after merge (the coordinator runs these)

1. Deploy; smoke check green (E1).
2. Game day against the monitor (M7): on a branch, break the route script's checkout in one workflow and dispatch it; the monitor raises H1 within two runs. Stop the box's reporter in `shadow`; H4 within two runs.
3. Shadow for 72 hours; attach the monitor's report (E2, E3).
4. Switch to `report`; attach the 7-day report (E4, M3–M6).

## 10. Owner inputs

Each has a default the swarm uses if no answer arrives. None needs a secret.

| # | Input | Default |
| --- | --- | --- |
| P1 | What happens to [#1935](https://github.com/Hobo-Labs/HoBo/pull/1935). It edits the files layers 04 and 07 own, hands the capacity variable to a script through an environment variable (R2), and its `trunkMemoryAdmit` reads a busy box as out of room (R4). Section 6.5 replaces what it set out to do | Close as superseded; layer 05 carries over its `schedule` event fix |
| P2 | Merge #1943 and #1952, or leave the stack on them | Stack on them |
| P3 | The ARC pool: which labels it serves, its runner-name prefix, and how many jobs it really runs at once | Undeclared: the verdict then never says `no-capacity` while an ARC runner has taken a job in the past 15 minutes (F13), so E4 has no effect until this is answered |
| P4 | Enroll the box: run the printed command that adds its public key to the relay's configuration, and set the box's mode and relay origin | Stays `off` |
| P5 | What else runs on the box, and the memory to protect for CI | Runbook values only; nothing applied |
| P6 | The GitHub Actions budget, and the daily paid-minutes alert | No budget change; alert at 300 minutes |
| P7 | A way for the coordinator to read the box's log, or the owner pastes the lines the runbook names at each gate | Gates are judged from the status route and the monitor alone |
| P8 | Whether the unread `HOBO_CI_FLEET_ROUTES` variable is retired with the other two | Retired |

## 11. Assumptions to check first

An implementer who finds one false stops and reports; it does not design around it.

| # | Assumption | Check | If false |
| --- | --- | --- | --- |
| A1 | The box runs cgroup v2 and a job container's `memory.current` and `memory.stat` are readable the way `memory.peak` is | Run the read on the box | Use reservations only, mark every sample `estimated`, and raise the enter hold to 120 s |
| A2 | The poller's job lists include in-progress jobs with `runner_name` for runs on fleet labels | Read `github-job-poller.ts` and its tests | Add the read; budget one extra request per poll |
| A3 | The platform caches a function response with `s-maxage` | Deploy and read the response headers twice | Keep `no-store`; add a 5-second in-process cache |
| A4 | A scheduled workflow in this repository can mint an OIDC token | GitHub documentation; the monitor's first run | The monitor skips H4 and H5 and says so (H9 does not fire for it) |
| A5 | Main-gate jobs run on `ubuntu-24.04` without the box's mounts | Layer 05's dispatched run | List what is missing; the coordinator decides before 05 merges |
| A6 | The hosted relay's runtime configuration can carry a public-key list without a schema migration elsewhere | Read `relay-runtime-config-schema.ts` and the config service notes | Report the migration as a `cascadeDelta` |

## 12. Considered and rejected

Each was attacked in review before this plan was written.

| Alternative | Why not |
| --- | --- |
| Capacity record handed to the route job through `vars` and an environment variable | Breaks R1 and R2; also read a busy box as out of room |
| The relay's route table indexed in a workflow expression | No timestamp, so a crashed relay can leave a paid label in force; breaks R2 |
| The probe as the signal | The relay cannot stop ARC taking the probe; a busy box reads as refusing for an hour |
| Verdict posted to a GitHub surface (deployment status) | Borrows a feature for another purpose and needs another App permission |
| Account bearer for reports | A stored secret on the box that can do more than report; ADR-0027 prefers identity |
| One elected reporter per mesh | A partitioned node elects itself; the agreement rule needs no election |
| A relay ledger of hosted spend with a deny switch | The hosted relay has no durable store; GitHub's budget already is the cap |
| A placements endpoint that assigns a label per shard | Needs a capacity figure outside the box relay; asking again before shards queue gives the same protection |
| Converting the route job into a reusable workflow | Touches six workflows, five lint rules and five test files to remove a risk a test already guards |
| `PSI` or load as a blocked reason | The box's own jobs cause them; they would break R4 |

## 13. Walkthrough

The path from cause to effect, each step naming what performs it.

| Step | What happens | Performed by |
| --- | --- | --- |
| 1 | Another workload takes memory; `MemAvailable` falls | The host |
| 2 | Every sample for 60 s shows `externalFreeMb − 4096 < 3072`; the declared ARC pool has no free slot; there is no mesh peer | Evaluator, layer 04 |
| 3 | State becomes blocked for `hobo` and `hobo-trunk`; a signed report is sent at once | State machine and reporter, layer 04 |
| 4 | The relay verifies it and keeps it for 180 s | Hosted relay, layer 03 |
| 5 | A run starts; its route job asks; within 5 s of step 4 the answer names the label; the run goes to GitHub-hosted runners and annotates why | Route job, layer 05 |
| 6 | Eight minutes later the plan job asks again; still blocked; shards go to GitHub-hosted runners | Plan job, layer 05 |
| 7 | Memory returns; 30 s of clear samples; a report blocking nothing is sent; the next run stays on the fleet | Layers 04, 03, 05 |
| 8 | If instead the box had died at step 3, the report lapses at 180 s and the queue decides as it does today | Hosted relay TTL |
| 9 | If instead the relay had been down at step 5, the route job logs that it gave no verdict and decides from the queue; the monitor raises H2 within two hours | Layers 05, 06 |
| 10 | If the block lasts past 240 minutes that day, the label is reported clear, runs queue, and H6 raises an issue | Layers 04, 06 |
