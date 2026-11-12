---
type: Architecture Decision Record
title: "Runner Routing Asks the Relay for a Fleet Verdict"
description: "Whether the fleet can take a run is decided by the relay and asked for over HTTP at decision time. No capacity figure leaves the relay, and nothing about the fleet reaches the route job through a repository variable or an environment variable."
tags: [hobo, design, adr, ci, relay, routing, fleet]
---

# ADR-0180 — Runner Routing Asks the Relay for a Fleet Verdict {#adr-0180}

**Status:** Accepted. Built: the record, the relay routes and stores, the
route job's client. Not built: the relay's reporter (waits on
[#1935](https://github.com/Hobo-Labs/HoBo/pull/1935), which edits the files it
lives in).
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
([finding 143](../../ci/findings/0143-route-job-read-a-capacity-record-no-worker-wrote.md)).
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

## Considered and rejected

Each candidate was put through an adversarial review and a step-by-step
explanation against the code before this was chosen.

| Candidate | Why not |
| --- | --- |
| The capacity record passed from `vars` through an input and an environment variable, judged in the script | The owner and transport faults above. It also read a box whose own jobs hold the memory as out of room, which would have sent runs to the paid tier while CI was merely busy |
| The relay's route table (`HOBO_CI_FLEET_ROUTES`) indexed in a workflow expression | The table has no timestamp and an expression cannot compare time. A relay that crashed with a paid label in the table would keep billing for as long as ARC answered the probe. The balancer also treats "every slot busy" as a reason to leave the fleet, and the expression would override a pinned tier |
| The probe as the signal: the relay takes the probe job only when it could take a real one | The relay cannot stop an ARC runner or an idle runner taking the probe, a busy box reads as refusing, and a slow pickup is held against the fleet for an hour |
| The relay posts an expiring verdict to a GitHub surface the job's token can read (a deployment status) | Workable and needs no hosted relay. Not chosen: it borrows a GitHub feature for something else, adds entries to the repository's deployments, and needs another App permission |

## Consequences

- **Routing depends on the hosted relay only as advice.** [CI Relay Mesh](../ci-relay-mesh.md)
  requires that taking a job from the queue to a runner never depends on the
  hosted relay. That still holds: a job already queued does not touch this
  route, and a route job the relay does not answer decides from the queue.
- **A box reports to the hosted relay.** The reporter needs an account
  credential and the hosted relay's origin, which a box in pull mode does not
  hold today. This is the first thing a box sends there.
- **A stolen reporting credential can keep a repository's runs off the fleet**
  for as long as it keeps reporting, which spends money on the paid tier. The
  credential is the account's own, the report is limited to repositories that
  account is connected to, each report lapses in at most five minutes, and a
  pinned `HOBO_CI_ROUTE=fleet` ignores the relay.
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
- **Until the reporter exists, nothing is reported.** The route job asks, the
  relay answers that nothing is blocked, and routing is what the queue says.
  The mesh's `HOBO_CI_FLEET_STATE` publisher still writes its variable; the
  route job no longer reads it.

## Not built

- **The reporter.** A relay host with a view of the fleet computes the verdict
  and sends it: `no-node` from the mesh board, and `no-capacity` from memory
  admission asked as if this box's own leases were gone, together with the
  mesh's free slots. It must hold a state for some seconds before reporting a
  change, so a verdict does not flap with one reading. It replaces the
  `HOBO_CI_FLEET_STATE` publisher. It lives in the daemon and relay files
  [#1935](https://github.com/Hobo-Labs/HoBo/pull/1935) edits, and follows it.
- **Main workspace plan** still reads `HOBO_CI_FLEET_CAPACITY`; #1935 hands it
  the variable through an environment variable. Moving it onto a relay answer
  is a separate change.

## Contracts and gates

- **Protobuf:** `packages/ci-gh-actions/data-models/fleet_verdict.proto`
  (`FleetVerdict`, `FleetVerdictBlock`, `FleetVerdictReport`); generated types
  in `src/_generated/fleet_verdict_pb.ts` (`pnpm run codegen:check`).
- **CUE:** `#FleetVerdict`, `#FleetVerdictReport` and their parts in
  `data-models/onboarding.cue`, with valid and invalid fixtures
  (`pnpm test:schema`). A capacity figure in a verdict is an invalid fixture.
- **Parse, don't validate:** `src/fleet-verdict.ts` is the one parser on the
  relay; a report becomes a `ParsedFleetVerdictReport` or nothing. The route
  job's reader is `parseFleetVerdict` in `route-runner.mts`, which loads no
  package.
- **PACT:** `contracts/fleet-verdict-boundary.pact.json`, verified against the
  real handler over HTTP (`fleet-verdict-boundary.provider.test.ts`). Its two
  consumers replay it: the reporting client
  (`fleet-verdict-client.consumer.test.ts`) and the route job
  (`scripts/test/route-runner.test.ts`, *the relay's verdict*).
- **Events:** none. A verdict is a relay's current answer held with a time to
  live, not a fact to replay; the reporter's own state is its event history.
