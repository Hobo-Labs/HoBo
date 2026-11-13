---
type: Architecture Decision Record
title: "Runner Routing Asks the Relay for a Fleet Verdict"
description: "Whether the fleet can take a run is decided by the relay and asked for over HTTP at decision time. No capacity figure leaves the relay, and nothing about the fleet reaches the route job through a repository variable or an environment variable."
tags: [hobo, design, adr, ci, relay, routing, fleet]
---

# ADR-0180 — Runner Routing Asks the Relay for a Fleet Verdict {#adr-0180}

**Status:** Accepted, amended 2026-11-12 ("Signed reports, agreement and
allowance" below). Built: the record, the relay routes and stores, signed
reports, agreement among enrolled reporters, the allowance, the reporter
status route, the route job's client. Not built: the box's reporter
([plan 0025](../../plans/0025-relay-owned-runner-routing.md), layer 03).
**Date:** 2026-11-12
**Amends:** [CI Relay Mesh](../ci-relay-mesh.md), "Routing reads the mesh when
it can" and "No hosted database in the job path";
[CI fleet balancing](../ci-fleet-balancing.md), "The route table".
**Supersedes, for the route job:** the `HOBO_CI_FLEET_STATE` and
`HOBO_CI_FLEET_CAPACITY` repository variables as inputs to
`scripts/ci/route-runner.mts`.

## Context

Every routed workflow starts with a **Route runners** job on `ubuntu-24.04`
that picks one `runs-on` label for the run: the fleet, an enrolled local box,
or GitHub-hosted, which is paid for. GitHub fixes a job's label when the job
is queued, so the choice has to be made first. The job decides from GitHub's
queue, which shows what happened to jobs already queued. It cannot show that
the fleet is unable to admit the next one: main run
[43207388098](https://github.com/Hobo-Labs/HoBo/actions/runs/43207388098) was
sent to a box with 2.4–4.4 GB free, where a 4096 MiB job needs 7168 MiB
([finding 142](../../ci/findings/0142-box-admission-counted-neither-promised-memory-nor-lasting-headroom.md)).

Two attempts put fleet facts in front of that job, and both went through the
workflow: a mesh snapshot in `HOBO_CI_FLEET_STATE`, and a capacity record in
`HOBO_CI_FLEET_CAPACITY`. Each is a repository variable a relay writes, read
from the `vars` context and handed to the script in an environment variable,
because a job's token is refused when it asks the API for a variable
([finding 146](../../ci/findings/0146-route-job-read-a-capacity-record-no-worker-wrote.md)).
The script then judged the facts itself.

That is the wrong owner and the wrong transport.

- **Owner.** Whether a label can take new work depends on memory admission,
  the mesh's free slots and what the relay is already running. Only the relay
  holds them. A script judging a copy repeats the relay's decision without the
  relay's knowledge. The copy also could not tell a box that is short of
  memory from one whose own CI jobs are using it: both read "cannot admit",
  and the second is only busy.
- **Transport.** A variable is as old as its last write, has no expiry, and
  outlives a relay that crashed. A value read at the start of a job and
  compared to a clock on another machine is a guess about now.

## Decision

**The relay decides; the route job asks.** A relay with a view of the fleet
reports, per repository, the fleet labels new work should stay off right now.
The hosted relay keeps the report for as long as it stands and serves it. The
route job asks for it over HTTP at the moment it decides.

1. **A verdict, not capacity.** The record names blocked labels, each with one
   of two reasons, and nothing else. `no-node`: no live, healthy node serves
   the label. `no-capacity`: nodes serve it, none can admit a job for a reason
   other than the jobs it is already running, and no other has a free slot.
   Slot counts and free memory stay inside the relay. A label that is only
   busy is not blocked: the queue's limits already cover a fleet that falls
   behind.
2. **Silence means the queue decides.** A label the verdict does not name is
   not vouched for. No verdict, an expired one, a relay that cannot be reached
   and a relay that names nothing all leave the route job deciding exactly as
   it does with no relay. A verdict can only take a backend out of a decision.
3. **The relay's clock, and an expiry.** A report carries how long it stands
   (at most 300 seconds). The relay that keeps it stamps it and stops serving
   it when it lapses. The reporter repeats it while it holds. A reporter that
   has died is forgotten within minutes, and no reader compares clocks.
4. **Asked at decision time.** The route job reads the relay's origin from
   the project's `.hobo/ci.json` (the default environment's `relayOrigin`) and
   sends `GET /v1/fleet/verdicts/{owner}/{repo}` with a three-second limit, on
   every pass of its decision. Nothing about the fleet is passed to it by the
   workflow: no input, no `vars`, no environment variable.
5. **Read by anyone, reported by the connected account.** The read takes no
   credential, because the job has none the relay could check (its OIDC token
   is not offered to fork pull requests, and its `GITHUB_TOKEN` is not the
   relay's to hold). The answer has the same shape for a repository with
   nothing blocked and one the relay has never heard of. A report needs an
   account credential with `operations:write`, from the account the repository
   is connected under; anyone else is answered 404.

### The routes

| Route | Who | Answer |
| --- | --- | --- |
| `GET /v1/fleet/verdicts/{owner}/{repo}` | Anyone | `200` with `FleetVerdict`: the repository in lower case and `blocked`, a map of label to `{reason}`; `observedAt` and `expiresAt` when something is blocked |
| `PUT /v1/fleet/verdicts/{owner}/{repo}` | Account bearer, `operations:write`, connected to the repository | Body `FleetVerdictReport`: `blocked` and `ttlSeconds` (1–300). Replaces what is kept; an empty `blocked` clears it. `200` with the verdict as stamped |

Both are served by the relay's one HTTP layer, so every host that serves HTTP
has them. The Node host keeps verdicts in the memory of its one process. The
hosted relay keeps them
in its cache under `fleet-verdict:<owner>/<repo>` with a time to live that
ends when the verdict does, which fits
[ADR-0179](./hosted-relay-stateless.md#adr-0179): losing the cache loses one
report, and a missing verdict already means "nothing blocked".

### What the route job does with it

| The relay | Routing |
| --- | --- |
| Names the run's label | That backend is refusing jobs, at once, and a probe is not waited for |
| Answers, and does not name it | Nothing. The queue decides |
| Is not named in `.hobo/ci.json`, or the tier is pinned | Not asked |
| Does not answer in three seconds, answers another status, or answers something that is not a verdict | Nothing, and the job's log line says the relay gave no verdict and why |

## Amendment: signed reports, agreement and allowance {#adr-0180-amendment}

**Date:** 2026-11-12. **From:** [plan 0025](../../plans/0025-relay-owned-runner-routing.md),
sections 6.1–6.4. It replaces items 3 and 5 of the decision and the `PUT`
row of the routes table; the rest stands.

**The box relay decides; the hosted relay keeps, agrees and serves.** The
reporter is the relay core inside the box's worker daemon. The hosted relay
never judges the fleet: it keeps each reporter's last report, works out
what they agree on, and serves that.

1. **When a label is blocked (the idle-only rule).** The box relay reports
   a fleet label blocked only while both hold. *The box is idle* (no lease
   in an active state for any connected repository, no launch slot in use,
   none of its own background work running) *and admission would still
   refuse a job*, evaluated purely on the current host sample:
   `hostMemoryAdmitFits(…)` is false, or the host health monitor's
   `current()` is `critical` for a disk or inode reason. The load average is
   left out: it stays high for minutes after CI's own jobs end. *And
   nothing else can take the job*: no mesh peer serving the label
   advertises a free slot; the declared pools
   (`HOBO_CI_FLEET_EXTERNAL_POOLS_JSON`) have fewer free runners than
   `HOBO_CI_FLEET_VERDICT_MIN_FREE_RUNNERS`, counted only from a poll in the
   last 60 seconds; and no runner the relay cannot account for took a job
   on the label in the last 15 minutes. While CI's own jobs run, the box
   is never blocked: a busy box is the queue's to judge (R4). The reason is
   always `no-capacity`; `no-node` stays in the record and this reporter
   never sends it.
2. **Timing.** A sample every 10 s; enter blocked after 60 s of blocked
   samples, leave after 30 s of clear ones; send at once on a change and
   every 60 s otherwise, one request per connected repository, each with a
   3 s limit and no retry beyond the next sample. A report lives 180 s (the
   record's limit, down from 300). Reporter modes: `off` (the default),
   `shadow`, `report`.
3. **Signed reports (replaces item 5's account bearer).** A report is
   `PUT /v1/fleet/verdicts/{owner}/{repo}` signed with the reporter's
   Ed25519 key (`loadMeshIdentity` on `HOBO_CI_MESH_KEY_FILE`, mesh or no
   mesh). No bearer or other secret is sent (ADR-0027); the key can do
   nothing but sign reports. Headers: `X-HoBo-Reporter`, `X-HoBo-Sequence`
   (a decimal integer, persisted beside the journal, never reused),
   `X-HoBo-Issued-At` (RFC 3339 with milliseconds), `X-HoBo-Signature:
   ed25519=<base64url>`. The signed text is seven fields joined by `\n`:
   `hobo-fleet-verdict-v1`, `PUT`, the relay origin, the path (both lower
   case), the hex SHA-256 of the body, the issued-at and the sequence
   (`fleetVerdictSigningInput` in `src/fleet-verdict-auth.ts`, pinned by
   three fixed vectors). The body adds `mode` (`shadow` or `report`).
4. **Enrollment.** The hosted relay's runtime configuration lists who may
   report: `HOBO_CI_FLEET_REPORTERS_JSON`, a `FleetReporterEnrollments`
   record of id, public key, account and labels, at most eight per account,
   public keys only. `HOBO_CI_FLEET_VERDICT_SERVING=off` is the kill switch
   (reads block nothing, reports answer 503);
   `HOBO_CI_FLEET_VERDICT_DAILY_BLOCK_MINUTES` sets the allowance (240).
5. **Accepting a report.** Checked in this order, each refusal answering
   its `reason` and logging `hobo_ci_fleet_verdict_refused` with the
   reporter id: no query string (`400 bad-request`); the reporter is
   enrolled (`401 unknown-reporter`); the signature verifies over this
   relay's configured public origin, never the request's `Host`
   (`401 bad-signature`); issued-at within 120 s of this relay's clock
   (`401 clock-skew`); the sequence above the last accepted from this
   reporter for this repository (`401 replayed`); the repository connected
   under the reporter's account (`404 not-found`); the body a report naming
   only labels the reporter is enrolled for (`400 invalid-report`).
   Otherwise `200` with the entry as stamped.
6. **What is kept**, per repository: `fleet-verdict:<repo>:<reporter>`
   (the reporter's last report as stamped, until it expires; a `shadow`
   report is kept as blocking nothing), `fleet-reporter:<repo>:<reporter>`
   (`FleetReporterState`: last sequence, mode, last report, and per label
   when it last blocked and cleared; a day, refreshed on every report) and
   `fleet-allowance:<repo>` (`FleetVerdictAllowance`; a day from its
   window's start).
7. **Agreement.** The served verdict blocks a label only when every
   reporter enrolled for the repository's account whose labels include it
   is live, in `report` mode, and blocks it. One that is silent, in
   `shadow`, or says the label is open leaves it open; one that does not
   serve the label has no say. An enrolled box that is switched off
   therefore keeps its labels open until it is taken out of enrollment.
8. **Allowance.** The relay counts the time the agreed verdict blocks a
   label: on each accepted report, for each label blocked just before it,
   `min(now − lastCountedAt, 180 s)`. Two reporters blocking together are
   counted once. A window starts at its first counted second and lasts a
   day; once it holds the allowance, the label is served open and the
   status route says so. A lost cache restarts the window, so the bound is
   two allowances in any 24 hours.
9. **Reporter status.** `GET /v1/fleet/reporters/{owner}/{repo}` answers a
   GitHub Actions OIDC token whose audience is this relay's origin and whose
   `repository` is the path's, from any event, for a connected repository:
   a `FleetReporterStatusList` of each enrolled reporter's state and
   liveness and each label's allowance. It never names a key. The verifier
   is `createGithubWorkflowVerifier` (`src/workflow-oidc.ts`); the runner
   claim verifier in `oidc.ts` is unchanged.

**What is retired.** The account-bearer report and the client's
`putFleetVerdict`. The `HOBO_CI_FLEET_STATE` and `HOBO_CI_FLEET_CAPACITY`
publishers and records go in a later layer of the plan; the route table and
its `HOBO_CI_FLEET_ROUTES` publisher stay.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /v1/fleet/verdicts/{owner}/{repo}` | Anyone | As before; the agreed verdict less any label whose allowance is spent. A query string answers 400. Two cache round trips at most for a connected repository (one on the hosted relay), none for an unconnected one |
| `PUT /v1/fleet/verdicts/{owner}/{repo}` | An enrolled reporter's signature | The checks of item 5; `200` with the entry as stamped |
| `GET /v1/fleet/reporters/{owner}/{repo}` | A workflow of that repository (OIDC) | `FleetReporterStatusList` |

## Considered and rejected

Each candidate was put through an adversarial review and a step-by-step
explanation against the code before this was chosen.

| Candidate | Why not |
| --- | --- |
| The capacity record passed from `vars` through an input and an environment variable, judged in the script | The owner and transport faults above. It also read a box whose own jobs hold the memory as out of room, which would have sent runs to the paid tier while CI was merely busy |
| The relay's route table (`HOBO_CI_FLEET_ROUTES`) indexed in a workflow expression | The table has no timestamp and an expression cannot compare time. A relay that crashed with a paid label in the table would keep billing for as long as ARC answered the probe. The balancer also treats "every slot busy" as a reason to leave the fleet, and the expression would override a pinned tier |
| The probe as the signal: the relay takes the probe job only when it could take a real one | The relay cannot stop an ARC runner or an idle runner taking the probe, a busy box reads as refusing, and a slow pickup is held against the fleet for an hour |
| The relay posts an expiring verdict to a GitHub surface the job's token can read (a deployment status) | Workable and needs no hosted relay. Not chosen: it borrows a GitHub feature for something else, adds entries to the repository's deployments, and needs another App permission |
| An account bearer for reports (this ADR as first written) | A stored secret on the box that can do more than report. Replaced by a signing key that can only sign reports |
| Agreement among whichever reporters happen to be live, or one elected reporter | A stuck or unrelated reporter vetoes forever, a second box in shadow is ignored, and a partitioned node elects itself. Enrollment names who must agree |
| The allowance kept on the box | It would not cover several reporters, a forged report or a restart |
| Memory "as if CI's jobs were gone", from container cgroups | Job containers start siblings through the Docker socket and page cache is counted twice; it blocks a busy box and misses a blocked one. The idle-only rule replaces it |

## Consequences

- **Routing depends on the hosted relay only as advice.** [CI Relay Mesh](../ci-relay-mesh.md)
  requires that taking a job from the queue to a runner never depends on the
  hosted relay. That still holds: a job already queued does not touch this
  route, and a route job the relay does not answer decides from the queue.
- **A box reports to the hosted relay.** The reporter needs its signing key,
  its enrollment and the hosted relay's origin; it holds no secret of the
  hosted relay's. This is the first thing a box sends there.
- **A stolen reporter key can keep a repository's runs off the fleet** only
  for its account's connected repositories and enrolled labels, only while
  every other reporter enrolled for a label agrees, and only up to the daily
  allowance; taking it out of enrollment revokes it. A pinned
  `HOBO_CI_ROUTE=fleet` ignores the relay.
- **The read is open.** Anyone can ask whether a repository's fleet labels are
  blocked. The answer names labels and a reason. It cannot be used to learn
  whether a repository exists, and only a repository some account is
  connected under is looked up, so a made-up name costs the relay no read of
  its store. Nothing limits how often it is asked beyond what the host limits.
- **One relay per project.** The route job asks the default environment's
  relay in `.hobo/ci.json`, whatever the event; it does not apply the file's
  selection rules. Every environment that takes CI names the same relay today.
- **Paid routing is still outside the budget.** A run the route job sends to
  GitHub-hosted never passes relay admission
  ([CI fleet balancing](../ci-fleet-balancing.md), "What is not built"). A
  verdict changes when that happens, not that it is unaccounted.
- **Until a reporter is enrolled and in `report` mode, nothing is blocked.**
  The route job asks, the relay answers that nothing is blocked, and routing
  is what the queue says. The mesh's `HOBO_CI_FLEET_STATE` publisher still
  writes its variable; the route job no longer reads it.

## Not built

- **The reporter.** The box relay's evaluator, hold and sender of the
  amendment's items 1–3, in the worker daemon
  ([plan 0025](../../plans/0025-relay-owned-runner-routing.md), layer 03).
  It signs with `fleetVerdictSigningInput` and reports with
  `signedFleetVerdictRequest`; its three log events are already named in
  `src/cloud-events.ts`.
- **Main workspace plan** still reads `HOBO_CI_FLEET_CAPACITY`; #1935 hands it
  the variable through an environment variable. Moving it onto a relay answer
  is a separate change.

## Contracts and gates

- **Protobuf:** `packages/ci-gh-actions/data-models/fleet_verdict.proto`
  (`FleetVerdict`, `FleetVerdictBlock`, `FleetVerdictReport`,
  `FleetReporterEnrollments`, `FleetReporterState`, `FleetVerdictAllowance`,
  `FleetReporterStatusList` and their parts); generated types in
  `src/_generated/fleet_verdict_pb.ts` (`pnpm run codegen:check`). The
  hosted relay's three settings are in `packages/ci-vercel/data-models/relay_runtime_config.proto`.
- **CUE:** a definition for each in `data-models/onboarding.cue`, with valid
  and invalid fixtures (`pnpm test:schema`). A capacity figure in a verdict,
  a report without a mode, a private key in an enrollment and any key in a
  status are invalid fixtures.
- **Signing:** `src/fleet-verdict-auth.ts`, three fixed vectors in
  `test/fleet-verdict-auth.test.ts`.
- **Parse, don't validate:** `src/fleet-verdict.ts` is the one parser on the
  relay; a report becomes a `ParsedFleetVerdictReport` or nothing. The route
  job's reader is `parseFleetVerdict` in `route-runner.mts`, which loads no
  package.
- **PACT:** `contracts/fleet-verdict-boundary.pact.json`: one interaction per
  check of item 5, agreement, a shadow report, a spent allowance and the
  status route's answers, verified against the real handler over HTTP
  (`fleet-verdict-boundary.provider.test.ts`). Its consumers replay it: the
  reporter's signing (`fleet-verdict-client.consumer.test.ts` rebuilds every
  signed request with `signedFleetVerdictRequest`), the status client, and
  the route job (`scripts/test/route-runner.test.ts`, *the relay's verdict*).
- **Agreement and allowance:** `test/fleet-verdict-agreement.test.ts`,
  `test/fleet-verdict-allowance.test.ts`; the cache binding in
  `packages/ci-vercel/test/fleet-verdict-cache.test.ts`.
- **Events:** a verdict is a relay's current answer held with a time to
  live, not a fact to replay. Three log events are named as CloudEvents
  types: `hobo_ci_fleet_verdict_state`, `hobo_ci_fleet_verdict_unaccounted_runner`
  (the reporter's) and `hobo_ci_fleet_verdict_refused` (the hosted relay's).
