# Vibe Support Workflow Mockups - Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-550. It records
how support workflow mockup fixtures are parsed, how support evidence stays
customer-safe, how HOBO-577 quickstart fixture ids constrain downstream support
copy, and which runtime work remains outside this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeSupportWorkflowMockups` checks the raw mockup fixture at the boundary
and returns `ParsedVibeSupportWorkflowMockups`. Downstream proof code consumes
the parsed domain type rather than passing raw strings and rechecking support
state, requester, customer-safe summary, severity, affected surface, owner route,
evidence links, redaction state, next update condition, proof mode, and HOBO-577
fixture ids in every view.

## Event Architecture

This package does not implement support runtime. It names the event model later
runtime work must preserve:

- **Command** - `supportWorkflowMockup.Accept` records an accepted support
  mockup fixture.
- **Event** - `supportWorkflowMockup.Accepted` appends the support state,
  fixture, scenario, proof-mode, and accessibility evidence.
- **Actor** - `SupportWorkflowMockupActor` owns the parsed fixture and rejects
  helpdesk, support queue, customer-data, incident-command, on-call, production
  UI, SLA, or proofless launch-claim creep.
- **Event store** - accepted mockup evidence is appended to the platform event
  store as design-time evidence.
- **Materialized view / projection** - `SupportWorkflowMockupView` folds
  accepted events into the read model consumed by later support case prototype
  slices.
- **Snapshot** - the parsed HOBO-550 record is replayable from its accepted
  event and carries redaction and proof-mode labels.
- **Read store** - later M2 support case work reads the snapshot, not issue-body
  text or live support ticket state.

No helpdesk software, ticket queue automation, production support UI,
customer-data access, incident command, on-call staffing, notification dispatch,
contractual SLA promise, or unsupported launch claim is implemented here.
