---
type: Implementation Plan
title: "Relay-owned runner routing: one-shot delivery plan"
description: "Complete design and swarm handoff for making the relay the only judge of whether the fleet can take a run: the verdict reporter, signed reports, main-gate routing, a monitor for silent fallbacks, retirement of the superseded variable channels, a failure table and measurable outcomes."
tags: [hobo, ci, relay, routing, fleet, resilience, implementation, sdlc]
---

# Relay-owned runner routing: one-shot delivery plan

**Status:** implemented in the stack sdlc/routing-01…07; operating checklist (section 6.10) not yet run. Its record is [finding 145](../ci/findings/0145-fleet-verdict-channel-operating-record.md). Design revision 3: revision 1 went through an adversarial review and an implementer walk-through; revision 2 through a confirming review that replayed the incident against it. Section 13 lists what each changed. Two design choices carry defaults the owner may change before dispatch: P3 and P10 in section 10.
**Design authority:** [ADR-0180](../design/adr/fleet-verdict.md#adr-0180). Layer 02 amends it with the decisions here.
**Base of the stack:** `claude/relay-fleet-verdict` ([#1952](https://github.com/Hobo-Labs/HoBo/pull/1952)), which sits on [#1943](https://github.com/Hobo-Labs/HoBo/pull/1943). If both have merged, base on `main`.

**What "one shot" means here.** The whole build is one stack of seven layers, with nothing left for a later project. Proof in production takes clock time by its nature, so section 6.10 is an operating checklist with evidence gates, run after the stack merges. It adds no code.

## 1. How to use this document

- **Coordinator (parent session).** Run the repo's `sdlc` protocol. Each layer in section 9 becomes one issue: its body there, plus the design sections it cites, copied in verbatim. Own every item marked *coordinator*. Record the chain in `docs/plans/relay-owned-runner-routing/sdlc-state.md` before dispatch.
- **Implementers.** One layer each. Red test, minimal fix, commit. `pnpm agent:check -- --staged` before every commit. Conventional commits, several per layer. Touch only the files your layer owns; anything else is a `cascadeDelta` in `.sdlc/report.json`.
- **Reviewers.** Check the layer against its acceptance list and against every row of sections 7 and 8 that names the layer.

## 2. Problem

| Incident (2026-11-12) | Evidence | Cause |
| --- | --- | --- |
| A main run went to a fleet that could not admit its jobs; shards started 14–36 minutes late and two timed out | Run [43207388098](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098), [finding 142](../ci/findings/0142-box-admission-counted-neither-promised-memory-nor-lasting-headroom.md) | Nothing that routes a run can see what the relay knows, and the main gate's jobs are pinned to `hobo-trunk` whatever the route job decides |
| Every unpinned run of four workflows went to paid runners | Run [43239493135](https://github.com/Hobo-Labs/HoBo/actions/runs/43239493135), [finding 146](../ci/findings/0146-route-job-read-a-capacity-record-no-worker-wrote.md) | The route script crashed on a file the workflow did not check out; the step fell back with a warning nobody read |
| The shard planner used its default cap in both runs checked | Jobs `131146352582`, `131259868933`: `variables/HOBO_CI_FLEET_CAPACITY returned 403` | A job token cannot read a repository variable; the failure is swallowed |
| A broken script test reached a green pull request | [#1943](https://github.com/Hobo-Labs/HoBo/pull/1943), `scripts/test/main-gate-workspace-shards.test.ts` | No pull-request job runs `scripts/test` |

**The shared pattern:** a signal was built and unit-tested on both sides, never observed carrying a value in production, and failed into a default without telling anyone.

## 3. Goals and rules

**Goals**

1. A run does not go to the fleet while the relay knows the fleet cannot take it for a reason waiting will not fix.
2. Only the relay judges what the fleet can take. Workflows ask it and obey.
3. Every fallback to a default leaves a record a monitor reads, and the monitor raises it within two of its runs.
4. The two variable channels this work supersedes are removed.
5. Time a verdict can keep runs on paid runners is bounded by the relay, and paid minutes are visible.

**Not in scope, and why**

- **A relay ledger of GitHub-hosted spend.** The hosted relay keeps no durable state ([ADR-0179](../design/adr/hosted-relay-stateless.md#adr-0179)); GitHub's billing is the record. Section 6.7 says what bounds cost instead.
- **Changing the route job's queue heuristics.** The owner's instruction for this work was that a fleet which is merely busy "should keep the existing queue heuristics". They remain the detector for a fleet that is down or saturated. Section 10 (P6) asks whether to revisit them.
- **Attributing memory to CI while CI is running.** Section 6.1 explains why this design does not try.

**Owner rules (binding on every layer)**

- **R1.** Whether the fleet can take work is decided by the relay. No workflow, script or action derives it from fleet figures (free memory, free slots, node counts).
- **R2.** No fleet state reaches a workflow through a repository variable, an action input or an environment variable. A workflow learns it by asking the relay when it decides. Operator settings (`HOBO_CI_ROUTE`, `HOBO_CI_LOCAL_RUNNER`, `HOBO_CI_TRUNK_RUNNER`, the queue limits) are configuration, not fleet state, and are untouched.
- **R3.** A relay signal that is missing, stale, unreadable or unverified changes nothing: the decision is whatever it would be with no relay.
- **R4.** The relay never reports a label blocked because the box is busy with CI's own jobs.

## 4. Terms

| Term | Meaning |
| --- | --- |
| **Box** | The machine that runs the worker daemon (`packages/ci-gh-actions/scripts/isolated-worker-daemon-main.mts`). It runs the relay core and has no HTTP listener |
| **Box relay** | The relay core inside that daemon. It is what decides (R1) |
| **Hosted relay** | The same relay code served over HTTP at the origin `.hobo/ci.json` names (`https://hobo-ci.vercel.app`). It keeps and serves; it never decides |
| **Reporter** | The part of the box relay that evaluates and sends reports. Identified by a reporter id and an Ed25519 key |
| **Enrolled** | Listed, with its public key, labels and account, in the hosted relay's runtime configuration |
| **Fleet label** | `hobo` or `hobo-trunk`, the `runs-on` labels the box serves |
| **Live** | A reporter whose last accepted report has not expired (180 s) |
| **Idle** | The box has no lease in an active state (for any connected repository), no launch slot in use, and none of its own background work running: a deps-image build, a warm container being created, a garbage-collection pass |
| **Reporter mode** | `HOBO_CI_FLEET_VERDICT_MODE` on the box: `off`, `shadow`, `report` |
| **Route mode** | The existing `HOBO_CI_ROUTE` pin (`auto`, `fleet`, `local`, `github`) |
| **Routed workflow** | One of the six that use `./.github/actions/route-runner` |

## 5. Facts the design rests on

Checked in the code or in production logs on 2026-11-12.

| Fact | Where |
| --- | --- |
| The box daemon has no HTTP listener, no public URL and no credential for the hosted relay | daemon `:272-276,945` |
| `admit` mutates admission state. The pure checks are `hostMemoryAdmitFits`, `hostPressureBlocksAdmission`, `hostCpuAdmitFits`, `memoryAdmitHeadroom`; the daemon already calls one outside admission | `src/isolated-worker/host-resource-pressure.ts:170,267,300`; daemon `:836` |
| The daemon does not read live container memory, and job containers mount the Docker socket, so a job's sibling containers are outside its cgroup | `cli-docker-driver.ts:44-53,524` |
| The host health monitor exposes `current()` without sampling, and its reasons name the resource | `host-health.ts:58-62,179` |
| There is no mesh unless `HOBO_CI_NATS_URL` is set; ARC is never a mesh node | `mesh-worker.ts:75` |
| ARC runners take jobs on the fleet labels (`hobo-runner-*`). The poller ingests such a job as `foreign-runner` and keeps no count. `runnerCustody` calls any `hobo-<uuid>` runner `box`, this host's or a peer's | Run 43207388098; `hosted-relay.ts:976-982`; `job-runner-custody.ts:4-16` |
| The poller reads at most 50 runs per poll, pauses until the rate limit resets, and sees only connected repositories | `github-job-poller.ts:112,341-360` |
| `loadMeshIdentity(path)` creates or loads an Ed25519 key with safe file modes; today it is called only when there is a mesh | `mesh-node.ts:86`; daemon `:978-983` |
| `createGithubOidcVerifier` accepts only `workflow_dispatch` tokens and serves the runner claim | `oidc.ts:5-18` |
| The hosted relay's runtime configuration is a strict schema generated from protobuf | `packages/ci-vercel/src/relay-runtime-config-schema.ts:1-6,122-125` |
| `main-gate-plan`, `main-gate`, `main_workspace_tests` and `main_gate_finish` use a fixed trunk expression. Shards need `ci-deps-image`, which is fleet-only by design. The plan job has `contents: read` only and restores a cache keyed by commit before it plans | `.github/workflows/hobo-ci.yml:199-205,876,936,1161,1173,1266`; `plan-main-workspace-shards.mts:83` |
| The route job, the required pull-request gate and any monitor run on GitHub-hosted runners | `hobo-ci.yml:50,751` |
| The relay deploy is Vercel's Git integration; the workflow only observes it, and may see a protected URL answer 401 | `relay-deploy.yml:153-202` |
| The staged docs-freshness check fails a commit that changes code under `scripts/**` or a workflow without a doc change | `scripts/check-docs-freshness.ts:5-17` |
| `pnpm run test:scripts` fails 8 tests on `main` in a clean container; no workflow runs it | Measured; `hobo-ci.yml` |

## 6. Design

### 6.1 When the relay says a label is blocked

**Rule.** The box relay reports a fleet label blocked only while both hold:

1. **The box is idle and admission would still refuse a job.** With no CI job running, any shortfall is by definition not CI's own (R4). "Would refuse" is the conjunction admission itself uses, evaluated purely on the current host sample with nothing committed:
   - `hostMemoryAdmitFits(availableMb, standardClassMb, reserveMb, volatilityMb, pressure, thresholds, 0)` is false (memory headroom, memory and CPU pressure stall, swap), or
   - the host health monitor's `current()` verdict is `critical` for a disk or inode reason.

   The load-average check admission also makes (`hostCpuAdmitFits`) is deliberately left out: the one-minute load average stays high for minutes after CI's own jobs end, so an idle box would read as refused because of work CI itself just finished (R4).
2. **Nothing else can take the job.** All of:
   - **Mesh peers** (only when a mesh exists): no other live healthy node serving the label advertises a free slot.
   - **Declared pools.** Over the pools in `HOBO_CI_FLEET_EXTERNAL_POOLS_JSON` whose `labels` include this label, the free runners (`maxRunners − busy`, summed, never below zero) number fewer than `HOBO_CI_FLEET_VERDICT_MIN_FREE_RUNNERS` (integer ≥ 1, default 1). `busy` counts in-progress jobs on those labels whose `runner_name` starts with the pool's `runnerNamePrefix`. The count is used only if the poller completed a poll within the last 60 seconds; otherwise the pool is unknown and the label is not blocked (R3).

     One free runner elsewhere keeps a label open by default. That is not enough to carry a run of several parallel jobs: in finding 142 the box was refusing and ARC ran one job at a time. The owner sets the minimum to what a run needs from the rest of the fleet (P3).
   - **No unaccounted runner.** In the last 15 minutes no job on the label was taken by a runner that is neither a lease of this box, nor a declared pool's, nor a mesh peer's. If one was, capacity exists that the relay cannot count; the label is not blocked and `hobo_ci_fleet_verdict_unaccounted_runner` is logged once per runner-name prefix per hour.

The reason is always `no-capacity`. `no-node` stays in the record and this reporter never sends it.

**It reads the current sample.** Admission reads the lowest free memory over 60 seconds; the evaluator reads the latest reading and relies on the 60-second hold (6.2). The relay can therefore call a label open up to 30 seconds before admission would admit, and pressure that swings faster than the hold never blocks. Both fail open.

**Why idle only.** While CI jobs run, the host's free memory, pressure and load are a mix of CI's and everyone else's. Job containers start siblings through the Docker socket, so even per-container accounting misattributes. A box that external pressure stops from admitting anything becomes idle within one job's length, and the rule then fires. A box that is running some jobs and refusing others is saturated, which the queue heuristics already cover.

**The evaluator is pure.** It takes a host sample, the idle flag, the pools' counts with their ages, mesh peers, and recent foreign pickups; it returns blocked or not per label, with the reasons it found. It never calls `admit`, `availableLowWaterMb`, or anything on the admission object.

### 6.2 State, timing, lifetime

| Rule | Value |
| --- | --- |
| Sample interval | 10 s |
| Enter blocked | every sample in the last 60 s blocked (`HOBO_CI_FLEET_VERDICT_ENTER_MS`) |
| Leave blocked | every sample in the last 30 s clear (`HOBO_CI_FLEET_VERDICT_EXIT_MS`) |
| Send | at once on a change; otherwise every 60 s, including when nothing is blocked. One request per connected repository |
| Lifetime of a report | 180 s (`ttlSeconds`; 180 is also `FleetVerdictReport`'s limit, down from 300) |
| Send attempt | one request, 3 s limit. A failed send is tried again at the next sample while a change is unsent, otherwise at the next 60 s mark. No other retry |
| On drain or stop | one last report that blocks nothing, best effort |
| Log | `hobo_ci_fleet_verdict_state` on every change and at most once per 5 minutes otherwise |

The reporter runs on its own unreferenced timer, like the mesh beat. Nothing in admission, dispatch or the poller awaits it.

Reporter modes: `off` (default; no timer), `shadow` (evaluates, logs, and reports with `mode: "shadow"`), `report`.

### 6.3 Reports are signed

A report is a `PUT /v1/fleet/verdicts/{owner}/{repo}` signed with the reporter's Ed25519 key. No bearer or other secret is sent (ADR-0027), and the key can do nothing but sign reports. The account-bearer write in #1952 is removed.

- **Key.** `loadMeshIdentity` on `HOBO_CI_MESH_KEY_FILE` (its existing default path), whether or not a mesh exists.
- **Reporter id.** `HOBO_CI_FLEET_REPORTER_ID`, matching `^[A-Za-z0-9_-]{1,64}$`; defaults to the mesh node id when there is a mesh; required otherwise.
- **Headers.** `X-HoBo-Reporter`, `X-HoBo-Sequence` (decimal integer), `X-HoBo-Issued-At` (RFC 3339, milliseconds, `Z`), `X-HoBo-Signature: ed25519=<base64url, no padding>`.
- **Signing input.** Seven fields joined by a single `\n`, no spaces, no trailing newline: `hobo-fleet-verdict-v1`, `PUT`, the relay origin (lower case, no trailing slash), the request path (lower case), the lower-case hex SHA-256 of the body bytes, the issued-at string, the sequence string. Layer 02 implements `fleetVerdictSigningInput()` once, with three fixed test vectors; the reporter and the relay both import it.
- **Sequence.** Persisted in `fleet-verdict-state.json` beside the journal. Next value is `max(last + 1, current time in ms)`, written before the request is sent.
- **Box settings.** `HOBO_CI_FLEET_VERDICT_MODE`, `HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN` (https; required unless the mode is `off`), `HOBO_CI_FLEET_REPORTER_ID`, `HOBO_CI_FLEET_EXTERNAL_POOLS_JSON` (default `[]`; example `[{"labels":["hobo","hobo-trunk"],"runnerNamePrefix":"hobo-runner-","maxRunners":1}]`), `HOBO_CI_FLEET_VERDICT_MIN_FREE_RUNNERS` (default 1), and the two hold times. An invalid value refuses to start, as other daemon settings do.

### 6.4 The hosted relay keeps, agrees and serves

**Enrollment.** Runtime configuration gains `HOBO_CI_FLEET_REPORTERS_JSON`: `{"reporters":[{"id","publicKey","accountId","labels":[…]}]}`, at most 8 per account, public keys only, and `HOBO_CI_FLEET_VERDICT_SERVING` (`on` by default; `off` is the kill switch: reads answer "nothing blocked", reports answer 503).

**Accepting a report.** All must hold, else the answer carries a `reason` and nothing is stored:

| Check | Failure |
| --- | --- |
| The request has no query string | `400 bad-request` |
| The reporter is enrolled | `401 unknown-reporter` |
| The signature verifies over the signing input, built with this relay's configured `publicOrigin`, never the request's `Host` | `401 bad-signature` |
| Issued-at is within 120 s of this relay's clock | `401 clock-skew` |
| The sequence is higher than the last accepted from this reporter for this repository | `401 replayed` |
| The repository is connected under the reporter's account | `404 not-found` |
| The body parses as a report and names only labels the reporter is enrolled for | `400 invalid-report` |

Each refusal logs `hobo_ci_fleet_verdict_refused` with the reporter id and reason.

**What is kept**, per reporter and repository:

| Key | Holds | Lifetime |
| --- | --- | --- |
| `fleet-verdict:<owner>/<repo>:<reporter id>` | the report: mode, blocked labels | until it expires (180 s) |
| `fleet-reporter:<owner>/<repo>:<reporter id>` | `FleetReporterState`: last sequence, mode, `lastReportAt`, and per label `lastBlockedAt`, `lastClearedAt` | 24 hours, refreshed on every accepted report |
| `fleet-allowance:<owner>/<repo>` | per label: window start, blocked seconds in the window | 24 hours from the window start |

**Agreement.** The served verdict blocks a label only when **every** reporter enrolled for the account the repository is connected under, whose `labels` include the label, is live, in `report` mode, and blocks it. One reporter that is silent, in `shadow`, or says the label is open is enough to leave it open (R3). A reporter that does not serve the label has no say. An enrolled box that is switched off therefore keeps its labels open: take it out of enrollment for maintenance (runbook, layer 07).

**Allowance.** It counts the time the *agreed* verdict blocks a label. On each accepted report, for each label the agreed verdict blocked just before this report, the relay adds `min(now − lastCountedAt, 180 s)` to the label's blocked seconds, then sets `lastCountedAt`. A report lives 180 s, so that cap is the most one report can account for, and two reporters blocking together are counted once. A window starts at the first counted second and lasts 24 hours. While the window's total is at or above 240 minutes (`HOBO_CI_FLEET_VERDICT_DAILY_BLOCK_MINUTES` in runtime configuration), the served verdict does not block that label, and the status route says so. Kept at the relay so it covers every reporter and survives a box restart. If the cache is lost the window restarts; the bound is then two allowances in any 24 hours, the same as across a window boundary. It is checked when a verdict is read: a read for a connected repository costs at most two cache round trips (one on the hosted relay, which reads the reporters' entries and the allowance together); a read for an unconnected one still costs none.

**Routes.**

| Route | Who | Answer |
| --- | --- | --- |
| `GET /v1/fleet/verdicts/{owner}/{repo}` | Anyone | As in #1952: same shape, same answer for an unknown repository, no store read for an unconnected one, `Cache-Control: no-store`. A query string answers 400 |
| `PUT /v1/fleet/verdicts/{owner}/{repo}` | An enrolled reporter's signature | `200` with the stored entry as stamped |
| `GET /v1/fleet/reporters/{owner}/{repo}` | A GitHub Actions OIDC token: audience this relay's origin, `repository` equal to the path's, repository connected, any event | `FleetReporterStatusList`: per enrolled reporter serving this repository's account, its `FleetReporterState`, whether it is live, and per label the allowance used and whether it is spent |

The status route needs a second verifier, `createGithubWorkflowVerifier({ audience })`, in a new file. The runner-claim verifier in `oidc.ts` is not edited.

### 6.5 Workflows: route once, ask again before shards

**Route job annotations.** One per decision, on one line:

```text
::notice title=hobo-ci-route::{"v":1,"workflow":"<file>","tier":"fleet|local|github","runner":"<label>","relay":"verdict|unanswered|unasked","why":"<see below>","refusedBy":"relay|queue|none"}
```

`why` is `no-relay`, `pinned`, `attested` or `queue-unread` when `relay` is `unasked`: `no-relay` whenever no relay is configured, whatever else happened (so H3 counts every such run); otherwise `pinned` for a pinned tier, `attested` when a signed local run covers the tree, and `queue-unread` when a relay is configured but the queue could not be read before asking it; the existing unanswered text when `unanswered`; empty otherwise. `refusedBy` says what took the fleet out of the decision. The action's fallback path emits `::warning title=hobo-ci-route-fallback::<reason>`. These record the job's own decision.

**Main gate follows the route.** In `hobo-ci.yml`, for `push` to `main`, `schedule` and `workflow_dispatch`:

1. `main-gate-plan` and `main-gate` gain `needs: route` (keeping their other needs) and use the routed expression every other routed job uses.
2. `main-gate-plan` gains `permissions: actions: read` and a step `reroute`, placed **after the job's full `actions/checkout`** (the bootstrap checkout holds only `.github/actions`; the route script, `packages/ci/src/fleet-overflow.ts` and `.hobo/ci.json` exist only after the full one) and guarded by `if: needs.route.outputs.tier == 'fleet'`. It uses `./.github/actions/route-runner` with the same five operator inputs as the route job and two new inputs: `attest: "false"`, which skips the attestation step, and `include-own-run: "true"`, which makes the queue reading include this run's own jobs. The job outputs `shard_runner: ${{ steps.reroute.outputs.runner || needs.route.outputs.runner }}`. A run already sent to GitHub-hosted runners is not asked again, so it cannot come back to a fleet whose deps job was skipped. The plan script and its cache are unchanged: the shard count does not depend on the tier.
3. `main_workspace_tests` and `main_gate_finish` gain `route` and `main-gate-plan` in `needs` where missing and use `runs-on: ${{ needs.main-gate-plan.outputs.shard_runner || needs.route.outputs.runner || <the trunk expression they use today> }}`, so a failed or skipped plan job never leaves `runs-on` empty.
4. `ci-deps-image` gains `needs: route` and, for these three events only, is skipped when `needs.route.outputs.tier != 'fleet'`, unless the route job did not succeed (`|| needs.route.result != 'success'`): a failed route job falls back to the trunk label, so the deps image must still be built (fail open). Its pull-request behaviour is unchanged. `main_workspace_tests` accepts a skipped `ci-deps-image`.
5. `scripts/lint-actions.ts` learns the `shard_runner` expression as a routed form, and the route-runner action learns the `attest` input.

**Why the re-ask reads the run's own jobs.** The route job leaves its own run out of the queue reading, rightly: at that moment the run has queued nothing. By the time the plan job runs, the run's own jobs are the freshest evidence there is. In finding 142 the plan job itself waited 444 seconds for a runner; with its own run included, the existing rule "a job has waited past the limit" (120 s) takes the fleet out of the decision and the shards go to GitHub-hosted runners. This uses the route script's existing rules on one more run's jobs; it does not change the route job (P10).

**Residual window, accepted.** If the fleet becomes blocked in the minute or so between the route job and the pickup of `ci-deps-image` or `main-gate-plan`, those two jobs wait on the fleet as they do today. Monitor signal H6 reports it.

**No capacity reader.** `scripts/ci/load-fleet-capacity.mts` is deleted. `plan-main-workspace-shards.mts` takes its cap from `MAIN_WORKSPACE_PARALLEL_CAP` when set, else the constant 4 it has effectively always used. That constant sizes shards; it is a tuning setting in the script, not a reading of the fleet.

**Lint (R2).** `scripts/lint-actions.ts` rejects any workflow or action text matching `vars\.HOBO_CI_FLEET_`, or an input or environment name matching `^(fleet-(state|capacity|routes)|HOBO_CI_FLEET_(STATE|CAPACITY|ROUTES))`.

### 6.6 Loud fallbacks: the monitor

`.github/workflows/ci-health.yml`: every two hours and on `workflow_dispatch` (input `dry-run`), on `ubuntu-24.04`, permissions `actions: read`, `checks: read`, `issues: write`, `id-token: write`. It runs `scripts/ci/ci-health.mts`, which loads no package.

**Window and budget.** Each run uploads its report, breach or not, with a `windowEnd`. The next run covers runs created since the `windowEnd` in the newest `ci-health-report` artifact, or the last two hours when there is none, so a failing run still moves the window on. At most 100 runs, newest first. It reads the run list, each run's jobs, and the annotations of two check runs per run (the route job and, on main-gate runs, **Main workspace plan**, where `reroute` annotates with the same titles): at most 350 API requests. If more than 100 runs fall in the window it processes 100 and reports `truncated`. A rate-limit answer ends the run as failed without opening an issue.

| Signal | Computed from | Breach |
| --- | --- | --- |
| **H1** routing did not run | `hobo-ci-route-fallback` warnings | any |
| **H2** relay asked, no verdict | route notices with `relay: unanswered` over those with `verdict` or `unanswered` | more than 5% of at least 20, or all of at least 5 |
| **H3** relay not asked | route notices with `relay: unasked` and `why: no-relay` | any |
| **H4** reporter silent | status route: a reporter whose state says `shadow` or `report` and whose `lastReportAt` is more than 10 minutes old | any |
| **H6** stall | jobs whose labels are a fleet label and that waited more than `CI_HEALTH_STALL_MINUTES` for a runner, or have been queued that long, excluding `main-gate` (it waits on its concurrency group). Default 30: eight shards of up to 12 minutes over three slots wait about 24 on a healthy fleet; finding 142's shard 5 waited 36 | any |
| **H8** paid minutes | durations, rounded up to the minute per job, of jobs whose labels include `ubuntu-24.04`, excluding the route job and the gate jobs that always run there | more than `CI_HEALTH_PAID_MINUTES_PER_WINDOW` (an `env` in the workflow file, default 150) |
| **H10** allowance spent | status route | any label |

For each breach it opens an issue titled `[ci-health] <signal>: <summary>` with label `ci-health`, assigned to the login in `CI_HEALTH_ASSIGNEE` (an `env` in the workflow file), or comments on the open issue with that signal's prefix. It never closes issues. It writes the full report to the step summary and uploads it as artifact `ci-health-report`, and exits non-zero on any breach. With `dry-run` it prints and writes nothing to issues.

If the status route cannot be reached or refuses the token, H4 and H10 are reported as `unknown`, which is not a breach on its own. If the previous report (already read for the window) was `unknown` too, it raises H2's issue with that note.

### 6.7 What bounds cost

1. **The relay's allowance** (6.4): at most 240 minutes of verdict-blocked time per label per 24-hour window, two windows' worth across a boundary or a cache loss. This bounds time, not money: the money is that time multiplied by how many runs start.
2. **Visibility:** H8 raises paid minutes per window, split in the report by what refused the fleet (`relay`, `queue`, fallback).
3. **Switches:** `HOBO_CI_FLEET_VERDICT_SERVING=off` on the hosted relay; reporter mode `shadow` or `off` on the box; `HOBO_CI_ROUTE=fleet` to pin every run.
4. **Not a routing control:** a GitHub Actions budget. The route job and the required pull-request gate run on GitHub-hosted runners, so a spent budget stops all CI, not just overflow. Set its alerts well below the limit; never rely on the limit.

A blocked main push costs on the order of 100 billed minutes (the full gate plus up to 8 shards).

### 6.8 Retirement

Removed: the `HOBO_CI_FLEET_STATE` publisher, record, fixtures and daemon wiring; the `HOBO_CI_FLEET_CAPACITY` publisher, record and CUE definition. `fleetCapacity.snapshot` stays: dispatch reads it (`hosted-relay.ts:1432`); only `publish` goes. The route table and its `HOBO_CI_FLEET_ROUTES` publisher are **not** touched: they belong to fleet balancing, are off by default, and no workflow may read the variable (6.5 lint). Section 10 (P8) asks whether to retire them too.

### 6.9 Replay against the incident

The design is checked against run 43207388098 as it happened, and layer 04 turns the second row into a test (B8).

| Moment | What was true | What this design does |
| --- | --- | --- |
| 11:14, route job | The box was refusing jobs for lack of memory. ARC took a job ten seconds after it was queued, so it had one runner free | With the ARC pool declared and the minimum set above its size (P3): the box is idle and refusing, the rest of the fleet is below the minimum, and once that has held for 60 s the label is blocked. The whole run goes to GitHub-hosted runners. With the default minimum of 1: open, and the run goes to the fleet as it did |
| 11:22, plan job | The plan job had waited 444 s for a runner | The re-ask reads the run's own jobs, sees a wait past the 120 s limit, and sends the shards and the finish job to GitHub-hosted runners, whatever the verdict says |
| 11:22–11:58 | Shards started 14–36 minutes late | Does not happen under either row above. If it did, H6 raises it within two monitor runs |

### 6.10 Operating checklist (after the stack merges; no code)

Order matters: the hosted relay learns the new configuration keys before anyone sets them, because its configuration schema is strict.

| Step | Do | Evidence before the next step |
| --- | --- | --- |
| G1 | Merge the stack. Vercel deploys the hosted relay. The smoke check in `relay-deploy.yml` probes the public origin. Dispatch `ci-health.yml` once with `dry-run: true` (it can be dispatched only once it is on `main`) | Smoke check green. The dry run's report is complete. Monitor: H2 clear over 24 hours with at least 20 asks |
| G2 | Enroll the box: run `node packages/ci-gh-actions/scripts/fleet-reporter-enroll.mts` on the box; it prints the JSON entry to add to `HOBO_CI_FLEET_REPORTERS_JSON`. Add it with `hobo ci`. Set the box to `shadow`, declare the ARC pool and the minimum free runners (P3), restart the daemon | Status route shows the reporter live in `shadow` |
| G3 | **Forced-pressure game day, shadow.** On the box, while CI is idle: `node packages/ci-gh-actions/scripts/hold-memory.mts --mb <enough to fail admission> --seconds 300`. A block also needs the rest of the fleet below the minimum: with the minimum above ARC's size it always is; otherwise hold ARC's runners with a dispatched job for the same five minutes | Status route shows the label's `lastBlockedAt` within 90 s of the start and `lastClearedAt` within 60 s of the end. The served verdict stayed open throughout |
| G4 | Leave in `shadow` for 72 hours | H4 clear. Compare `lastBlockedAt` history with H6 stalls: record both in the finding |
| G5 | Set `report`. Repeat the game day while a dispatched run is routed | The route notice says `refusedBy: relay` and the run's jobs use GitHub-hosted runners; after the hold ends, the next dispatched run stays on the fleet. This is the one production observation the channel needs |
| G6 | Seven days | H6 zero, H8 and H10 within bound |
| G7 | Delete the repository variables `HOBO_CI_FLEET_STATE` and `HOBO_CI_FLEET_CAPACITY` | — |

**Rollback.** Any step: its own switch (6.7). To take the code out: first remove `HOBO_CI_FLEET_REPORTERS_JSON` and `HOBO_CI_FLEET_VERDICT_SERVING` from the hosted relay's configuration, then revert on `main`. Reverting first would make the older relay refuse its configuration at cold start. A relay that does not answer never stops a run (R3), so rollback is not urgent.

## 7. Failure scenarios and resiliency

"Unknown" means the consumer decides as it would with no relay (R3). Test paths are relative to `packages/ci-gh-actions/` unless they start with `scripts/` or `packages/`.

| # | Failure | Behaviour | Pattern | Layer: test file › title begins |
| --- | --- | --- | --- | --- |
| F1 | Hosted relay down, slow, 5xx | Route job: unknown after 3 s, logged. Reporter: next attempt at the next sample or 60 s mark | Timeout, fail-open | 04: `scripts/test/route-runner.test.ts` › "reads any failure as no verdict" (exists). 03: `test/fleet-verdict-reporter.test.ts` › "tries again at the next sample" |
| F2 | Hosted relay's cache lost | Entries return within 60 s; allowance window restarts; replay protection resumes from the next report | Rebuild from source | 02: `packages/ci-vercel/test/fleet-verdict-cache.test.ts` › "after the cache is lost" |
| F3 | Box crashes while blocked | Entry expires in 180 s; label opens | Dead-man's switch | 02: same file › "serves what was reported until it expires" |
| F4 | Box drains or restarts | Final clear report; sequence continues above the last one | Graceful stop, durable sequence | 03: `test/fleet-verdict-reporter.test.ts` › "clears on drain", › "never reuses a sequence, even if the clock steps back" |
| F5 | Reporters disagree; one silent; one in shadow; one stuck open | Label open | Unanimity, fail-open | 02: `test/fleet-verdict-agreement.test.ts` › one title per case |
| F6 | Report replayed, or replayed at another relay or path | Refused `replayed` or `bad-signature` | Monotonic sequence, origin and path in the signature | 02: `contracts/fleet-verdict-boundary.provider.test.ts` › Pact interactions "refuse a replayed report", "refuse a report signed for another origin" |
| F7 | Reporter key stolen | Can block only its account's connected repositories and enrolled labels, bounded by the allowance; remove it from enrollment | Least privilege, allowance, revocation | 02: Pact "refuse an unknown reporter"; `test/fleet-verdict-allowance.test.ts` › "stops serving a block once the allowance is spent" |
| F8 | Reporter clock off by more than 120 s | Refused `clock-skew`; reporter goes silent to the relay; H4 | Bounded skew | 02: Pact "refuse a report outside the clock window". 05: `scripts/test/ci-health.test.ts` › "H4" |
| F9 | Readings flap around the threshold | Enter needs 60 s blocked, leave needs 30 s clear | Hysteresis | 03: `test/fleet-verdict-state.test.ts` › "does not enter on a dip", › "does not leave on a spike" |
| F10 | Fleet stuck blocked for hours | Allowance spent: label served open; H10 | Budget on the verdict | 02: `test/fleet-verdict-allowance.test.ts`. 05: › "H10" |
| F11 | Box busy with its own jobs | Never blocked | Idle-only rule | 03: `test/fleet-verdict-evaluator.test.ts` › "a box that is not idle is never blocked" |
| F12 | Pool counts stale (poller paused, GitHub down or rate-limited) | Pool unknown: not blocked | Freshness, fail-open | 03: same file › "a pool count older than 60 s is unknown" |
| F13 | ARC present, not declared | Not blocked; logged | Fail-open on unaccounted capacity | 03: same file › "an unaccounted runner keeps the label open" |
| F14 | ARC declared larger than it is, or down | Under-blocks: runs wait; H6 | Detect by outcome | 05: › "H6" |
| F15 | Evaluator or reporter throws or hangs | Own timer; dispatch unaffected; no report, so the entry lapses | Bulkhead | 03: `test/fleet-verdict-reporter.test.ts` › "a hanging send does not delay a dispatch tick" |
| F16 | Verdict changes between routing and shards | Plan job asks again | Re-ask at the point of use | 04: `scripts/test/main-gate-workspace-shards.test.ts` › "shards use the plan job's own route" |
| F17 | Box and hosted relay on different versions | Relay refuses what it cannot parse (`invalid-report`); H4. Readers ignore unknown fields | Strict writer, tolerant reader | 02: fixtures; `test/fleet-verdict.test.ts` › "is refused when it is not one, whole" (exists) |
| F18 | Route script cannot run | Titled warning; H1 | Loud fallback | 04: `scripts/test/route-runner.test.ts` › "names the fallback". 05: › "H1" |
| F19 | Open read hammered | Unconnected names never reach the store; no credential or state is exposed | Cost isolation | 02: `packages/ci-vercel/test/stateless-relay.test.ts` › "does not touch the cache for a repository it has no connection to" (exists) |
| F20 | Fork pull request edits `.hobo/ci.json` | Affects only its own run | Containment | 04: `scripts/test/route-runner.test.ts` › "sends no credential" (exists) |
| F21 | GitHub budget spent | All CI stops, including the route job. Alerts must fire first | Not a control (6.7) | 07: runbook |
| F22 | Monitor cannot read its inputs | Run fails; status signals `unknown`; second time raises | Monitor the monitor | 05: › "unknown twice" |
| F23 | Bad relay deploy | Smoke check red; consumers unknown; revert in the order of 6.10 | Smoke test, safe rollback | 07: `scripts/test/relay-deploy-workflow.test.ts` › "probes the public origin" |
| F24 | A workflow reintroduces a fleet variable | Lint fails | Guardrail | 04: `scripts/test/lint-actions-runner.test.ts` › "rejects fleet state passed to a workflow" |
| F25 | A script test breaks | The scripts job fails the pull request | Gate | 01 |
| F26 | Reporter key file lost or regenerated | Refused `bad-signature`; H4; enroll again | Loud rejection | 02: Pact "refuse a bad signature" |
| F27 | Reporter enrolled under the wrong account or labels | `not-found` or `invalid-report`; H4 | Authorization at the relay | 02: Pact "refuse a report for a repository the reporter's account is not connected to", "refuse a label the reporter is not enrolled for" |
| F28 | Hosted relay cannot load its configuration at cold start | It answers 503 as today; consumers unknown | Existing behaviour | none new |
| F29 | Fleet blocks between the route job and the plan job's pickup | Those two jobs wait; H6 | Accepted residual (6.5) | 05: › "H6" |
| F30 | A second box without a mesh | Its pickups look unaccounted to the first: never blocked. Two boxes need a mesh and both enrolled | Fail-open | 03: evaluator › "a peer box without a mesh is unaccounted" |
| F31 | An enrolled box is switched off | Its labels cannot be blocked until it is taken out of enrollment | Unanimity, fail-open | 02: `test/fleet-verdict-agreement.test.ts` › "a silent enrolled reporter keeps the label open"; runbook |
| F32 | The re-ask step cannot run (files missing, script error) | Shards use the run's first route; the titled warning is on the plan job's check run; H1 | Fallback to the earlier decision, loud | 04: `scripts/test/main-gate-workspace-shards.test.ts` › "the re-ask runs after the full checkout and falls back to the run's route" |

## 8. Measurable outcomes

**Build outcomes** are proven by tests before the layer merges.

| # | Outcome | Target | Proven by |
| --- | --- | --- | --- |
| B1 | Time from the first blocked sample to a served block | ≤ 75 s (60 s hold + 10 s sample + 3 s send, with slack) | 03: integration test with an injected clock against the layer-02 handler |
| B2 | Time from the first clear sample to a served clear | ≤ 45 s; ≤ 180 s if the reporter died instead | 03: same; 02: expiry test |
| B3 | Dispatch tick with the reporter hanging | no tick delayed by more than 50 ms | 03: F15 test |
| B4 | Failure rows with a named passing test | every row in section 7 that names a test | reviewer |
| B5 | Workflows that pass fleet state | 0 | 04: F24 |
| B6 | Scripts lane | exits 0 on the CI image; a required job on pull requests | 01 |
| B7 | Requests the monitor makes per run | ≤ 350 | 05: test counting fetches over the largest fixture |
| B8 | The incident, replayed | With the job timeline of run 43207388098 as the queue (the plan job queued 444 s), the re-ask chooses GitHub-hosted runners for the shards | 04: `scripts/test/route-runner.test.ts` › "replays finding 142" |

**Operating outcomes** are proven in production by the checklist in 6.10; the monitor's uploaded reports are the record.

| # | Outcome | Target | Proven at |
| --- | --- | --- | --- |
| O1 | A forced block is served, and released | within 90 s and 60 s | G3, G5 |
| O2 | Route jobs that got a relay answer | ≥ 95% over 7 days | G6 (H2) |
| O3 | Routing fallbacks | 0 over 7 days | G6 (H1) |
| O4 | Fleet-label jobs waiting past the stall limit | 0 over 7 days | G6 (H6) |
| O5 | Verdict-blocked time per label | ≤ 240 minutes per window | G6 (H10) |
| O6 | Time for the monitor to raise an injected fault | within two monitor runs (≤ 4 hours) | Game day: dispatch a routed workflow from a branch whose route checkout is broken; H1 opens |

## 9. Delivery

### 9.1 The stack and what runs in parallel

```text
claude/relay-fleet-verdict (#1952)
 └── sdlc/routing-01-scripts-gate       coordinator
  └── sdlc/routing-02-relay             implementer A
   └── sdlc/routing-03-reporter         implementer A (same package as 02, so after it)
    └── sdlc/routing-04-route-main-gate coordinator
     └── sdlc/routing-05-ci-health      implementer B, then coordinator for the workflow file
      └── sdlc/routing-06-retire        implementer A
       └── sdlc/routing-07-ops-docs     coordinator
```

| Built at the same time | Why it is safe |
| --- | --- |
| 01 and 02 | 01 touches workflows and script tests; 02 touches two packages |
| 03, 04, and the script half of 05 | 03 is in `packages/ci-gh-actions`; 04 is workflows and `scripts/ci`; 05's script and test are new files. They agree through section 6: the annotation format (6.5), the status record (6.4) |

The coordinator adds layers to the stack in the numbered order, runs `gh stack rebase --upstack` after each, and closes out bottom-up, one pull request at a time. A layer later in the stack may edit a file an earlier layer owned; two layers built at the same time never share a file.

### 9.2 Ownership

| Layer | Owns | Its doc (the staged docs-freshness check needs one per layer) |
| --- | --- | --- |
| 01 | A new job `scripts-tests` in `.github/workflows/hobo-ci.yml` and its place in the `pr-gate` job's `needs` and result check; `scripts/relevant-check-policy.ts`; whatever the 8 failing tests need | `docs/ci/findings/0144-*.md` and the regenerated index |
| 02 | `packages/ci-gh-actions/`: `data-models/fleet_verdict.proto`, `onboarding.cue`, `data-models/fixtures/**/fleet-*`, `src/_generated/fleet_verdict_pb.ts`, `src/fleet-verdict.ts`, new `src/fleet-verdict-auth.ts`, new `src/workflow-oidc.ts`, `src/hosted-control.ts`, `src/http-handler.ts`, `src/client.ts`, `src/relay-host.ts`, `src/relay-cache/records.ts`, `src/cloud-events.ts` (all new event names, including the reporter's), `src/index.ts`, `contracts/fleet-verdict-*`, their tests. `packages/ci-vercel/`: `data-models/relay_runtime_config.proto` with its CUE and generated file, `src/relay-runtime-config-schema.ts`, `src/fleet-verdict-cache.ts`, `src/stateless-composition.ts`, `src/bindle.ts` (every setting the relay reads is declared there; `test/relay-bindle.test.ts` checks it), their tests. Tests and fixtures the record and event changes reach: `packages/ci-gh-actions/test/mesh-nodes-surfaces.test.ts`, `test/cloud-events.test.ts`, `test/fixtures/control-api-github.ts`, `test/fixtures/fleet-reporter-keys.ts`; `packages/ci-vercel/test/stateless-harness.ts`, `test/relay-runtime-config.test.ts` | `docs/design/adr/fleet-verdict.md`, both package READMEs, `data-models/README.md` |
| 03 | New `packages/ci-gh-actions/src/isolated-worker/fleet-verdict-evaluator.ts`, `fleet-verdict-state.ts`, `fleet-verdict-reporter.ts`; `src/isolated-worker/github-job-poller.ts`; `scripts/isolated-worker-daemon-main.mts`; new `scripts/fleet-reporter-enroll.mts`, `scripts/hold-memory.mts`; their tests. Exports its three modules from `src/index.ts` (the daemon imports only the package root; layer 02 is merged below it by then) | `packages/ci/RUNNER-QUEUE.md` |
| 04 | `scripts/ci/route-runner.mts`, `plan-main-workspace-shards.mts`, `load-fleet-capacity.mts` (deleted), `scripts/lint-actions.ts`, `.github/actions/route-runner/action.yml`, `.github/workflows/hobo-ci.yml`, the tests under `scripts/test/` for these, `test/actions-policy.test.ts` | `docs/design/ci-relay-mesh.md` |
| 05 | New `scripts/ci/ci-health.mts`, `scripts/test/ci-health.test.ts`, fixtures (implementer B). New `.github/workflows/ci-health.yml` and its allowance in `scripts/lint-actions.ts` (coordinator, after 04) | New `docs/ci/health-monitor.md` |
| 06 | `packages/ci-gh-actions/src/fleet-state.ts`, `fleet-capacity.ts`, `hosted-relay.ts` (the two publish calls), `hosted-runtime.ts`, `index.ts`, `data-models/mesh.proto`, `data-models/README.md`, `mesh-records.ts`, the daemon file (publisher wiring), `packages/ci/src/fleet/capacity-input.ts`, `fleet/capacity.ts` (a comment), `fleet/index.ts`, `data-models/ci.cue`, `packages/ci/RUNNER-QUEUE.md` (the passages on the two variables); their tests and fixtures, including `packages/ci/test/fleet-capacity.test.ts` | `docs/design/ci-fleet-balancing.md` |
| 07 | `.github/workflows/relay-deploy.yml`, `scripts/test/relay-deploy-workflow.test.ts`, `packages/ci-vercel/README.md` (runbooks), `docs/design/traceability.md`, `AGENTS.md`, `.github/pull_request_template.md`, this plan's status line | `docs/ci/findings/0145-*.md` |

### 9.3 One-shot bodies

**Guardrails for every layer.** Protobuf first, with generated types; a CUE definition for every message; one parser at each boundary, returning a parsed type or nothing; the Pact is the contract for the HTTP boundary; TypeScript only; `route-runner.mts` and `ci-health.mts` import no package; rules R1–R4.
**Definition of done for every layer.** Its acceptance commands pass; every commit passed `pnpm agent:check -- --staged`; its doc is updated; each row of sections 7 and 8 naming it has the named test passing; `.sdlc/report.json` lists commits, gates run and `cascadeDeltas`.

#### Layer 01: the scripts lane is a pull-request gate (coordinator)

- **Why.** F25, B6.
- **Context.** `pnpm run test:scripts` (`scripts/run-tests.ts --category=scripts`) is run by no workflow. On `main` in a clean container it fails in these suites: *workspace test shards on this repository*, *planCommands*, *the repository's own plans*, *main workspace affected-only*, *turbo unit tasks cover the old runner and every root shard input*, *workspace test duration balancing*.
- **Steps.** (1) Run the lane on the CI runner image and record which of the six fail there. (2) For each failure, find the cause and fix it; a test that needs a provisioned tool must get that tool from the job, not be skipped. (3) Add a routed job `scripts-tests` to `hobo-ci.yml`, on pull requests and merge groups, that runs the lane when the change touches `scripts/**`, `test/**` or `.github/**`, and add it to the `pr-gate` job's `needs` and to the results that job checks (`hobo-ci.yml`, the job named **PR impact gate**), so it is required. (4) Add the same lane to `scripts/relevant-check-policy.ts` for those paths. (5) Write the finding.
- **Out.** Any routing change.
- **Acceptance.** `pnpm run test:scripts` exits 0 on the CI image. `pnpm run actions:lint`. A scratch pull request that breaks one script test shows the new job red; link it in the report and close it.
- **Outputs.** The job's run link; the finding.

#### Layer 02: the relay keeps, agrees and serves (implementer A)

- **Why.** Sections 6.3 and 6.4, copied into the issue verbatim. F2, F3, F5–F8, F10, F17, F19, F26, F27.
- **Steps.**
  1. Records in `fleet_verdict.proto`: add `mode` (string) to `FleetVerdictReport` and lower its `ttlSeconds` limit from 300 to 180; add `FleetReporterLabelState`, `FleetReporterState`, `FleetReporterStatus`, `FleetReporterStatusList`, `FleetVerdictAllowance`. CUE for each; `mode` is `"shadow" | "report"`. Valid and invalid fixtures, including a status that carries a key (invalid). Run `pnpm codegen --filter packages/ci-gh-actions`.
  2. `fleet-verdict-auth.ts`: `fleetVerdictSigningInput(fields)`, `signFleetVerdictReport(identity, fields)`, `verifyFleetVerdictReport(publicKey, fields, signature)`, using `node:crypto`. Three fixed vectors in `test/fleet-verdict-auth.test.ts`.
  3. Runtime configuration: add the three keys of 6.4 (`HOBO_CI_FLEET_REPORTERS_JSON`, `HOBO_CI_FLEET_VERDICT_SERVING`, `HOBO_CI_FLEET_VERDICT_DAILY_BLOCK_MINUTES`) to `relay_runtime_config.proto`, its CUE and `relay-runtime-config-schema.ts`. Parse the reporters list into a typed value once.
  4. Store port: replace `FleetVerdictStore` with `read(repository, enrolled)` returning the agreed verdict, `accept(report)` applying the checks and the allowance, and `status(repository, enrolled)`. In-memory and cache implementations, using the three keys of 6.4.
  5. Routes in `hosted-control.ts`: signed `PUT` (remove the bearer path and its scope branch), `GET` unchanged apart from refusing a query string, and the status route behind `createGithubWorkflowVerifier` in `workflow-oidc.ts` (same key fetching as `oidc.ts`, any `event_name`, audience and repository checked).
  6. `http-handler.ts`: allow `/v1/fleet/reporters/`.
  7. `client.ts`: remove `putFleetVerdict`; keep `getFleetVerdict`; add `getFleetReporters(repository, oidcToken)`.
  8. `cloud-events.ts`: add every event named in sections 6.1, 6.2 and 6.4. `index.ts`: export the new public names.
  9. Rewrite `contracts/fleet-verdict-boundary.pact.json` with one interaction per row of the acceptance table in 6.4, plus agreement, shadow-not-served, allowance-spent and the status route's three answers. Update the provider and consumer tests in the same commits so the package stays green.
  10. Amend ADR-0180: signed reports, agreement, allowance, status route, idle-only rule, what is retired.
- **Out.** Anything under `src/isolated-worker/`, `oidc.ts`, `hosted-relay.ts`.
- **Acceptance.** `pnpm exec turbo run typecheck test --filter=@hobo/ci-gh-actions --filter=@hobo/ci-vercel`; `pnpm run codegen:check`; `pnpm test:schema`; `npm run architecture:guard`; `pnpm run docs:design-lint`.
- **Outputs.** The Pact file; the three signing vectors; the amended ADR.

#### Layer 03: evaluator and reporter (implementer A, after 02)

- **Why.** Sections 6.1–6.3 verbatim. F1, F4, F9, F11–F13, F15, F30; B1–B3.
- **Precondition.** #1935 is closed or merged (P1): this layer edits the daemon file.
- **Steps.**
  1. `github-job-poller.ts`: expose, per completed poll, the in-progress jobs on fleet labels with their `runner_name`, label and start time, and when the poll completed. Do not change what is ingested.
  2. `fleet-verdict-evaluator.ts`: the pure function of 6.1. Inputs are plain values. Use `leaseIdFromBoxRunnerName` and the box's own lease ids to tell this box's runners from a peer's.
  3. `fleet-verdict-state.ts`: sample ring, enter and leave holds, the 60 s send schedule, the persisted sequence.
  4. `fleet-verdict-reporter.ts`: builds the report, signs with layer 02's function, sends one 3 s `fetch` per connected repository, and handles modes, the final clear and logging.
  5. Daemon: read and validate the settings of 6.3; compute idle from active leases, `liveLaunchSlotsInUse` and the deps-ensure state; start the timer when the mode is not `off`; call the final clear from the existing drain path.
  6. `scripts/fleet-reporter-enroll.mts --key-file <path> --id <reporter id> --account <account id> --labels hobo,hobo-trunk`: load the identity and print the enrollment entry. Export the three new modules from `src/index.ts`. `scripts/hold-memory.mts`: allocate and touch `--mb` megabytes for `--seconds`, then exit.
  7. Document the settings and events in `RUNNER-QUEUE.md`.
- **Out.** `memory-admission.ts`, `host-resource-pressure.ts`, `hosted-relay.ts`, anything layer 02 owns.
- **Acceptance.** `pnpm --filter @hobo/ci-gh-actions test`; `pnpm exec turbo run typecheck --filter=@hobo/ci-gh-actions`; the tests named for layer 03 in section 7; a property test that for an idle box with no pools, no mesh and no foreign pickups the evaluator's answer equals "either check in 6.1 fails"; the B1 and B2 integration test against layer 02's handler through `controlHttp`.
- **Outputs.** The integration test's measured times in the report.

#### Layer 04: route job and main gate (coordinator)

- **Why.** Section 6.5 verbatim. F16, F18, F24; B5.
- **Steps.** In the order of 6.5, items 1–5, then the capacity reader's deletion, then the lint rule. `include-own-run` is read by `route-runner.mts` (`observeQueue` then keeps this run's jobs instead of leaving them out). The new `runs-on` form must be taught to all three places `scripts/lint-actions.ts` compares `runs-on` (near lines 490, 499 and 505). Rewrite `scripts/test/main-gate-plan-install-free.test.ts`, which imports the deleted reader. `packages/ci-gh-actions/test/deps-image-scope.test.ts` and `main-gate-image-wait.test.ts` pin `main-gate`'s needs; they expect `route` there too. The fixture for the lint rule (F24) uses `HOBO_CI_FLEET_ROUTES`, so layer 06's search does not trip on it. For each changed job, read every step and confirm it runs on `ubuntu-24.04` the way the routed pull-request jobs do.
- **Acceptance.** `pnpm run test:scripts`; `pnpm run actions:lint`; `pnpm run test:attestation`; `npx vitest run test/actions-policy.test.ts`. Two `workflow_dispatch` runs of HoBo CI Fabric on the branch, linked in the report. To pin them without touching repository variables, add a `workflow_dispatch` input `route` to `hobo-ci.yml`: a string, default empty, so an empty input leaves `vars.HOBO_CI_ROUTE` in force. It is used as `mode: ${{ inputs.route || vars.HOBO_CI_ROUTE }}` in the route job and the `reroute` step. With `route: github`, the plan, the full gate, every shard and the finish job run on GitHub-hosted runners and pass. With `route: fleet`, the run behaves as `main` does today.
- **Stop condition.** If a main-gate step cannot run on `ubuntu-24.04`, stop and report the step; do not work around it.

#### Layer 05: the monitor (implementer B, then coordinator)

- **Why.** Section 6.6 verbatim. F8, F10, F14, F18, F22, F29; B7.
- **Steps.** (1) Pure functions from recorded API pages to a report: one per signal. (2) A thin layer that fetches the window, with the request budget enforced. (3) Issue open-or-comment. (4) `--dry-run`. (5) Coordinator: the workflow file, and in `lint-actions.ts` an allowance for a hosted job named `ci-health` like the one for `route`.
- **Acceptance.** `node --import tsx --test scripts/test/ci-health.test.ts`, with a breaching and a clear fixture for each of H1, H2, H3, H4, H6, H8, H10, and the "unknown twice" case; `pnpm run actions:lint`; one local dry run against the live repository with a token that can read Actions (`GITHUB_TOKEN=<token> node --import tsx scripts/ci/ci-health.mts --dry-run`; the status signals will read `unknown` without an OIDC token), its report attached. The dispatched dry run is step G1.

#### Layer 06: retirement (implementer A)

- **Why.** Section 6.8. Goal 4.
- **Steps.** Delete the two publishers and their records, fixtures, exports and daemon wiring; keep `fleetCapacity.snapshot` and remove only `publish`; update the docs generator's inputs if it reads the deleted record.
- **Acceptance.** `git grep -nP 'HOBO_CI_FLEET_(STATE|CAPACITY)\b' -- 'packages/*/src' packages/ci-gh-actions/scripts packages/ci/RUNNER-QUEUE.md .github` prints nothing (tests, findings and ADR history may still name them); `pnpm exec turbo run typecheck test --filter=@hobo/ci --filter=@hobo/ci-gh-actions`; `pnpm run codegen:check`; `pnpm test:schema`.

#### Layer 07: operations and documents (coordinator)

- **Why.** Sections 6.7 and 6.10. F21, F23.
- **Steps.** (1) `relay-deploy.yml`: after the existing checks, read the public origin from `.hobo/ci.json` and require `GET /v1/fleet/verdicts/<this repository>` to answer 200 with a `repository` and a `blocked` object; it reports, since Vercel has already deployed. (2) Runbooks in `packages/ci-vercel/README.md`: enrollment, the switches, rollback order, the game day. (3) `AGENTS.md` and the pull-request template: *a change that adds or alters a channel between two deployed components is done only when one production observation of that channel carrying a value is linked*. (4) Traceability. (5) The finding: the evidence of section 2 and what each gate of 6.10 measured, filled in as the gates are passed. (6) Set this plan's status.
- **Acceptance.** `pnpm run lint:docs`; `pnpm run docs:design-lint`; `pnpm run docs:freshness`; `node --import tsx scripts/validate-traceability.ts`; `pnpm run actions:lint`; `node --import tsx --test scripts/test/relay-deploy-workflow.test.ts`.

## 10. Owner inputs

Each has a default the swarm uses if no answer arrives. None needs a secret.

| # | Input | Default |
| --- | --- | --- |
| P1 | [#1935](https://github.com/Hobo-Labs/HoBo/pull/1935): it edits the daemon file layers 03 and 06 own, passes the capacity variable to a script through an environment variable (R2), and its `trunkMemoryAdmit` reads a busy box as out of room (R4). Section 6.5 delivers what it set out to do | Close as superseded |
| P2 | Merge #1943 and #1952, or leave the stack on them | Stack on them |
| P3 | The ARC pool: the labels it serves, its runner-name prefix, how many jobs it runs at once; and how many free runners the rest of the fleet must have for a label to stay open while the box is refusing (`HOBO_CI_FLEET_VERDICT_MIN_FREE_RUNNERS`). **Design choice.** With the default of 1, the verdict would not have fired in finding 142, because ARC had one runner free | Pool not declared, minimum 1. An ARC pickup in the past 15 minutes then keeps the label open (F13), so G5 cannot show a block until this is answered. Recommended for this fleet: declare the pool and set the minimum above its size |
| P4 | Enrollment and the box settings (G2) | Reporter stays `off` |
| P5 | The login the monitor assigns issues to, and the paid-minutes threshold | The repository owner; 150 per window |
| P6 | Whether to revisit the route job's queue heuristics and its fall-back to GitHub-hosted runners when it cannot decide, both of which can send a busy fleet's runs to paid runners | Unchanged; H8 reports their cost |
| P7 | A way to read the box's log during the game days, or the owner pastes the `hobo_ci_fleet_verdict_state` lines | Gates are judged from the status route alone |
| P8 | Whether the unread `HOBO_CI_FLEET_ROUTES` publisher is retired too | Kept |
| P10 | **Design choice.** The plan job's re-ask includes the run's own jobs in its queue reading (6.5), so a plan job that itself waited past the limit sends the shards to GitHub-hosted runners | On |
| P9 | What else runs on the box. This design routes around external pressure; it does not reduce it | Nothing changed on the box |

## 11. Assumptions to check first

An implementer who finds one false stops and reports it.

| # | Assumption | Check | If false |
| --- | --- | --- | --- |
| A1 | The daemon can tell whether its own deps-image build is running | Read the deps-ensure code | Treat "deps build state unknown" as not idle |
| A2 | A scheduled workflow in this repository can mint an OIDC token | The monitor's first dispatched run | H4 and H10 stay `unknown`; say so in the report and tell the owner |
| A3 | Main-gate jobs run on `ubuntu-24.04` | Layer 04's dispatched run | Layer 04's stop condition |
| A4 | The check run of a job carries the annotations the route step emits | The monitor's fixtures are recorded from a real run | Read the route job's log through the API instead, within the same request budget |
| A5 | The hosted relay's cache supports the compare-and-set the allowance needs | `EphemeralStatePort` in `packages/core` | Already true; listed so it is tested |

## 12. Considered and rejected

| Alternative | Why not |
| --- | --- |
| Capacity record handed to the route job through `vars` and an environment variable | Breaks R1 and R2; read a busy box as out of room |
| The relay's route table indexed in a workflow expression | No timestamp, so a crashed relay can leave a paid label in force; breaks R2 |
| The probe as the signal | The relay cannot stop ARC taking the probe; a busy box reads as refusing for an hour |
| Verdict posted to a GitHub surface (deployment status) | Borrows a feature for another purpose and needs another App permission |
| Estimating memory "as if CI's jobs were gone" from container cgroups | Jobs start sibling containers through the Docker socket; page cache is counted twice; reads go through `docker exec` and time out under pressure. It blocks a busy box and misses a blocked one |
| Low-water window inside the evaluator | One dip would hold the reading low for the whole window and defeat the hold |
| Account bearer for reports | A stored secret on the box that can do more than report |
| One elected reporter per mesh | A partitioned node elects itself; unanimity needs no election |
| Agreement among whichever reporters happen to be live | A stuck or unrelated reporter vetoes forever, and a second box in shadow is ignored. Enrollment lists who must agree |
| Allowance kept on the box | Does not cover several reporters, a forged report or a restart |
| Retry with back-off and a circuit breaker in the reporter | A missed report lapses in the safe direction and the next sample retries; nothing is gained |
| A GitHub budget as the cost cap | It stops the route job and the required gate: a CI outage |
| A relay ledger of hosted spend | The hosted relay has no durable store |
| A placements route that assigns a label per shard | Needs a capacity figure outside the box relay; asking again before shards queue gives the protection |
| A tier-aware shard cap | Would carry the route's answer into the plan through an environment variable and split the plan cache |
| Platform caching of the open read | Saves nothing once unconnected names skip the store, and adds lag |
| Converting the route job into a reusable workflow | Six workflows, five lint rules and five test files to remove a risk a test already guards |
| Counters of refused reports, false-block detection, issues that close themselves | A silent reporter (H4) already shows refusals; false blocks are excluded by the idle rule and bounded by the allowance; closing issues needs state |

## 13. What the reviews of revision 1 changed

| Finding | Change |
| --- | --- |
| The memory test blocked a busy box and missed a blocked one | Idle-only rule (6.1) |
| A low-water window let one dip block | Removed; the hold is the only persistence (6.2) |
| Agreement ignored labels and modes | Unanimity among enrolled reporters serving the label (6.4) |
| The allowance was per box, per UTC day, and exempted forged reports | Kept at the relay per repository and label (6.4) |
| The plan job could not re-ask (no `actions: read`), its cache would replay the other tier's plan, shards waited on a fleet-only job, the finish job was pinned | 6.5, items 1–4; shard count no longer depends on the tier |
| "A GitHub budget is the hard cap" was a CI outage | 6.7, item 4 |
| The node identity and id exist only with a mesh; the sequence would not survive a clock step; replay window after expiry; origin not signed | 6.3; a 24-hour reporter record (6.4) |
| Layers shared files, layer 02 could not be green alone, two layers shared a package | Contract and relay merged; 03 after 02; ownership rule restated (9.1, 9.2) |
| Layers 01, 04, 05 owned no doc and would fail the staged docs check | A doc per layer (9.2) |
| Rollback would crash the relay on its strict configuration | Order in 6.10 |
| The smoke check probed a protected URL and could not stop the deploy | Probes the public origin and reports (layer 07) |
| Signals needed verdict history; the monitor's request budget was unstated; targets disagreed | H6 no longer needs history; `lastBlockedAt` and `lastClearedAt` kept per label; window and budget stated; one latency figure (two runs) |
| Outcomes could not be shown at merge, and gates could pass with no block ever observed | Build and operating outcomes separated; forced-pressure game days (6.10) |
| The route job's own heuristics also send runs to paid runners | Kept by the owner's instruction; stated in section 3 and asked in P6 |
| No body had steps, quoted decisions or outputs; test names were labels | Section 9.3; test files and titles in section 7 |

**From the confirming review of revision 2**

| Finding | Change |
| --- | --- |
| Replayed against finding 142, the rule did not block: ARC had one free runner at 11:14, and at 11:22 the hold could not have elapsed | A minimum of free runners elsewhere (6.1, P3); the re-ask reads the run's own jobs, whose 444-second wait is the evidence (6.5, P10) |
| The re-ask step ran before the files it needs were checked out and would have fallen back to paid runners, unseen | After the full checkout, only when the run is on the fleet, falling back to the run's route; the monitor reads the plan job's annotations (6.5, 6.6, F32) |
| The load-average check lags CI's own jobs by minutes and would block an idle box (R4) | Left out of the rule (6.1) |
| The allowance credited 60 s to reports that live 180 s, double-counted two reporters, and counted while the agreed verdict was open | Counts the agreed verdict's blocked time (6.4) |
| Agreement was not scoped to the account; the signature's origin was not named; reads now cost cache round trips | 6.4 |
| The monitor's window never advanced after a breach; H6 fired on a healthy saturated fleet; H8 missed rerouted shards | 6.6 |
| The daemon imports only the package root; reports are per repository; the enroll script had no arguments | Layer 03 |
| Layer 06's search failed on files it did not own; layer 05's dispatch was impossible before merge; the new job was not required; a test imported the deleted reader; the dispatch input overrode the operator pin | Layers 01, 04, 05, 06 |
| An enrolled box that is off keeps its labels open | Stated in 6.4; F31; runbook |
