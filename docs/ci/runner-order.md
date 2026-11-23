---
type: Architecture Decision Record
title: "A Runner Order Is Committed Configuration, Walked First-Fit"
description: "A repository's ordered preference of runner types (the HoBo fleet, connected machines, GitHub-hosted, hosted providers) is a RunnerOrder record committed as runnerOrder in .hobo/ci.json. One pure walk answers a relay job with a runner label, a label to queue on, or a reason. CI insight reports are pure functions over run history."
tags: [hobo, design, adr, ci, relay, routing, fleet]
---

# ADR-0183 — A Runner Order Is Committed Configuration, Walked First-Fit {#adr-0183}

**Status:** Accepted. Built: the records, the parser, the walk and its rules,
the committed `runnerOrder` block, the insight reports, the relay job in relay
mode, machines, limit readers, provider health, retries,
runner-less checks, stored history, the read API, the MCP tools and the
dashboard. Proven in production: failure diagnosis only. Relay mode stays off
by default ("Relay-mode default" below); what is still owed is in "Not built
or not proven".
**Date:** 2026-11-16; revised 2026-11-17
**Builds on:** [ADR-0181](../design/adr/routing-slips.md#adr-0181) (routing policy is
committed configuration; the relay decides; unknown changes nothing).
**Relates to:** [CI fleet balancing](../design/ci-fleet-balancing.md) (cost-ranked
admission), the [RelayRunner capture](../competitors/relayrunner.md).

## Context

HoBo CI chooses a runner in two ways. Relay admission ranks the offers an
account has published by what the job would cost and reserves budget for the
winner (`route` in `@hobo/ci`). The route job picks one label for a run from a
fixed tier order: the fleet, a local box, GitHub-hosted (`selectFleetBackend`).
Neither is a preference a person writes down. An owner cannot say "my machines,
then Blacksmith while it is under $100 this month, then GitHub-hosted", a job
cannot say which runner types it may use, and when nothing can take a job the
policy's only answer is to queue (`noEligibleProvider: "queue"`), with the
reason left in a log.

RelayRunner, read on 2026-11-16, is built on exactly that preference: an
ordered list walked first-fit, a relay job that names the runner types it
allows, a recorded reason for every step passed over, and a failure with the
reason when nothing fits. The comparison is in the
[capture](../competitors/relayrunner.md#parity-scorecard), and the
cases are scored on the generated [parity scorecard](parity-scorecard.md).

## Decision

1. **The runner order is a record.** `RunnerOrder`
   (`packages/ci/data-models/runner_route.proto`) holds the ordered steps, a
   retry policy, whether unhealthy runner types are skipped, and the size
   `auto` means. A step is `fleet`, `machine`, `github` or a hosted provider.
   `github` may carry a share of the included Actions minutes; a hosted
   provider may carry a monthly spend. `parseRunnerOrder` is the one parser.
2. **It is committed configuration.** The order lives in `.hobo/ci.json` as
   `runnerOrder`, beside `runnerRouting`, so it is reviewed like code and no
   variable or dashboard carries it (ADR-0181 R2). A block that is there but
   broken is refused, never replaced by the default.
3. **`fleet` is a step.** The HoBo isolated fleet sits in the order like any
   other runner type. It is the one step that may take a public repository or
   a fork's pull request, and only when the fleet is set up to isolate such
   jobs. A machine never takes either.
4. **A job only uses what its relay named.** `RunnerRouteRequest` carries one
   input per runner type the job allows. A type the relay leaves out is never
   used; a type the relay names that the order leaves out is never tried and
   is reported.
5. **One pure walk decides.** `decideRunnerRoute(order, request, facts)` walks
   the steps as written and returns a `RunnerRouteDecision` with one of three
   outcomes: `routed` (a label that can take the job now), `waiting` (every
   runner that fits is busy; the job queues on that step's label) or `none`
   (a reason). A hosted runner type passed over only as unhealthy takes the
   job before anything is waited on. Every step passed over is recorded with
   one of seventeen reasons.
6. **A missing measurement never blocks.** Minutes used, money spent and
   runner-type health are inputs. When one is absent the step is allowed
   (ADR-0181 R3: unknown changes nothing).
7. **Nothing is ranked here.** Cost ranking and budget reservation stay with
   allocation routing. A runner order is a preference; the ledger still
   reserves and settles what the chosen runner costs.
8. **Insight reports are pure.** `@hobo/ci/insights` computes signals, runner
   and job times, and a failed job's diagnosis from plain run values. The
   diagnosis uses fixed, exported pattern tables; no log text is sent to a
   model, and a re-run is called likely to pass only for a runner or network
   failure.

## Considered and rejected

| Candidate | Why not |
| --- | --- |
| An order edited in a dashboard and stored by the relay | ADR-0181 R2: routing settings are committed and reviewed; a stored order differs per relay and is invisible in a pull request |
| Extending allocation routing with a "preferred" weight | It would still rank; a preference that cost can override is not the order its author wrote |
| Folding the order into `runnerRouting` | `runnerRouting` is mirrored by a dependency-free reader the route job runs today; the order would change this repository's live routing before any host walks it |
| A model-backed failure classifier | The diagnosis has to be explainable and has to run where the logs are; the pattern tables print what was matched |
| Reusing `selectFleetBackend` | Its three tiers are fixed in code and it has no notion of what a job allows |

## Consequences

- **The route job and relay admission are unchanged.** This repository's
  route job and the allocation router do not read `runnerOrder`. A HoBo node
  walks it when it answers a relay job and `relayJobs.answer` is on for the
  node and for the repository.
- **Routing happens in HoBo CI, never in a workflow.** The only HoBo CI change
  a workflow gets is `runs-on` set to a HoBo label; HoBo CI routes the job when
  it claims it. HoBo ships no workflow that runs a routing or evaluator job and
  no command that writes one into a repository.
- **Two routing vocabularies exist.** Offers and budgets for admission; steps
  and limits for the order. The order's `fleet` step is where they meet.
- **Hosted provider labels are facts with a date.** The label catalog names
  the vendor page and the day each label family was read; a stale label makes
  a job wait, which the health record then notices.
- **A decision is replayable.** `RunnerRouteDecision` is the payload of
  `runner.route.Decided`; "where did this job run, and why" is a projection
  of that record.

## Relay-mode default

Relay mode stays off: `relayJobs.answer` is false unless a repository and a
node both write it. The default changes only after one production run shows a
relay job answered with no billed minute (case R01), and that run has not
been made. Turning it on for this repository on the deployed relay changes
production routing, so it was not done from the build session.

## Not built or not proven

The [parity scorecard](parity-scorecard.md) is the record; on
2026-11-17 it shows 26 of 57 cases `pass`, three built but not proven and
one met differently. The
[capture](../competitors/relayrunner.md#parity-scorecard) lists every
owed case with the run that would prove it. In short:

- **Owed production runs.** Relay mode (R01) and the runner-less title check
  (C01) need relay mode turned on for one repository on a deployed relay, and
  so does the failure case (R04). The runner-protocol client, machine connect, runner adoption, the billing
  reader and provider usage sync have run only against the GitHub simulator
  and their pacts.
- **Owed gauntlet scenarios.** Twenty-six cases have package tests, but
  their scenario under `features/hobo-ci-parity` is still pending, so the
  scorecard keeps the state they had before the build.
- **Not wired.** `adoptRunner` exists, but no `hobo ci runners` command calls
  it (case M10's bar names that command).
- **Met differently.** No human roles (S08). M08 is not built; when it is,
  its takeover email is met by the `machine.taken_over` event, not a message.

Failure diagnosis was run against GitHub on 2026-11-17: `hobo ci diagnose
44044299552` read a failed run of this repository and printed, for each of
its two failed jobs, the failed step, the log lines leading to the error and
the re-run outlook, with no model. The first job, a type check, was called a
build error that a re-run will not fix, which is right. The second, a gate
that failed because the first did, was called a test failure that a re-run
will not fix: the outlook is right and the kind is not. A gate that only
reports another job's result has no pattern of its own yet.

## Measurable outcomes {#adr-0183-outcomes}

| Id | Outcome | Check |
| --- | --- | --- |
| M1 | The skip reasons and hosted providers in CUE equal those in code | `test/runner-order-catalog.test.ts` |
| M2 | Every valid order fixture parses; every invalid one is refused by CUE and by the parser | `pnpm test:schema`, `test/runner-order-catalog.test.ts` |
| M3 | A step the relay did not name is never used; a named step outside the order is never tried | `test/runner-order-decide.test.ts` |
| M4 | A machine never takes a public repository or a fork; the fleet takes them only when isolated | `test/runner-order-decide.test.ts` |
| M5 | Unmeasured minutes or spend never block a step | `test/runner-order-decide.test.ts`, `test/runner-order-machines.test.ts` |
| M6 | A broken committed order is refused, not replaced | `test/runner-order-config.test.ts`, `test/ci-route.test.ts` |
| M7 | No `auto` label is `ubuntu-latest` | `test/runner-order-catalog.test.ts` |
| M8 | A re-run is called likely to pass only for a runner or network failure | `test/insights-failure-diagnosis.test.ts` |
| M9 | Every gauntlet case has one scenario and the scorecard matches the last run | `node --import tsx scripts/ci/parity-scorecard.mts --check` |

## Contracts and gates

- **Protobuf:** `runner_route.proto` (`RunnerOrder`, `RunnerOrderStep`,
  `RunnerRetryPolicy`, `RunnerRelayInput`, `RunnerRouteRequest`,
  `RunnerRouteSkip`, `RunnerRouteDecision`); generated
  `src/_generated/runner_route_pb.ts` (`pnpm run codegen:check`).
- **CUE:** `runner_route.cue`, with valid and invalid fixtures under
  `data-models/fixtures/runner_route/` (`pnpm test:schema`).
- **Parse, don't validate:** `parseRunnerOrder` returns a branded, frozen
  `ParsedRunnerOrder`; `parseCiRunnerOrder` reads the committed block and
  reports why a broken one was not used; `hobo ci route --facts` parses its
  file at the command's boundary.
- **Events:** the command `runner.route.Requested` and the event
  `runner.route.Decided` name the boundary a host implements; the decision
  record is the event payload and the read model's row.
- **PACT:** `packages/hobo/contracts/ci-insights-github.pact.json` pins the
  GitHub reads of the insight commands. The relay's GitHub boundary is pinned
  by the pacts under `packages/ci-gh-actions/contracts/` (relay answer,
  webhooks, billing, runner labels, read API, MCP tools).
