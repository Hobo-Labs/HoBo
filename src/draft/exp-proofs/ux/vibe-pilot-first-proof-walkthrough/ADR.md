# Vibe Pilot First-Proof Walkthrough - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-563. It
states how the M2 pilot walkthrough consumes HOBO-549 storyboard evidence, how
blockers route to owners without hidden implementation, and which runtime work
remains outside this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibePilotFirstProofWalkthrough` checks the raw walkthrough fixture at the
boundary and returns `ParsedVibePilotFirstProofWalkthrough`. Downstream proof
code consumes the parsed domain type instead of passing raw strings and
rechecking issue, source storyboard, stage, route, proof mode, support handoff,
or stale-evidence behavior at every callsite.

## Event Architecture

This package does not implement customer onboarding runtime. It names the event
model that later runtime work must preserve:

- **Command** - `pilotFirstProofWalkthrough.Accept` records an accepted
  workspace-to-first-proof walkthrough fixture.
- **Event** - `pilotFirstProofWalkthrough.Accepted` appends consumed HOBO-549
  stage evidence, scenario path, blocker route, support handoff, proof mode,
  accessibility, and stale-evidence refusal state.
- **Actor** - `PilotFirstProofWalkthroughActor` owns the parsed fixture and
  rejects CRM, customer-success automation, support tooling, customer-data,
  tenant-mutation, provider, or launch-claim creep.
- **Event store** - accepted walkthrough evidence is appended to the platform
  event store as design-time evidence.
- **Materialized view / projection** - `PilotFirstProofWalkthroughView` folds
  accepted events into the read model consumed by customer onboarding, support,
  docs, launch, and release-cutline slices.
- **Snapshot** - the parsed HOBO-563 record is replayable from its accepted
  event and carries route-level owner and support handoff labels.
- **Read store** - later prototype work reads the snapshot, not issue-body text
  or live customer state.

No customer-success automation, CRM, live customer data, production tenant
mutation, provider deployment, support tooling, or launch claim is implemented
here.
