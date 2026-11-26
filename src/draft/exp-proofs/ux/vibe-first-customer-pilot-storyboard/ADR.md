# Vibe First-Customer Pilot Storyboard - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-549. It
states how pilot storyboard fixtures are parsed, how script artifacts stay
customer-safe, how HOBO-577 quickstart fixture ids constrain downstream pilot
copy, and which runtime work remains outside this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeFirstCustomerPilotStoryboard` checks the raw storyboard fixture at the
boundary and returns `ParsedVibeFirstCustomerPilotStoryboard`. Downstream proof
code consumes the parsed domain type instead of passing raw strings and
rechecking stage, consent state, proof mode, blocker category, owner, safe next
action, customer-safe message, or HOBO-577 quickstart fixture id at every
callsite.

## Event Architecture

This package does not implement customer onboarding runtime. It names the event
model that later runtime work must preserve:

- **Command** - `pilotStoryboard.Accept` records an accepted first-customer
  pilot storyboard fixture.
- **Event** - `pilotStoryboard.Accepted` appends the stage, script artifact,
  scenario, proof-mode, accessibility, and quickstart fixture evidence.
- **Actor** - `PilotStoryboardActor` owns the parsed fixture and rejects CRM,
  automation, support tooling, customer-data, tenant-mutation, provider, or
  launch-claim creep.
- **Event store** - accepted pilot storyboard evidence is appended to the
  platform event store as design-time evidence.
- **Materialized view / projection** - `PilotStoryboardView` folds accepted
  events into the read model consumed by later customer onboarding, docs,
  support, and launch-demo slices.
- **Snapshot** - the parsed HOBO-549 record is replayable from its accepted
  event and carries stage-level consent and proof-mode labels.
- **Read store** - later M2/M5 prototype work reads the snapshot, not issue-body
  text or live customer state.

No CRM, customer-success automation, support tooling, live customer data,
production tenant mutation, provider deployment, credential use, or launch claim
is implemented here.
