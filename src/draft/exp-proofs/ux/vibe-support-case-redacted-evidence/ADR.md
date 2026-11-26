# Vibe Support Case Redacted Evidence - Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-564. It records
how a support case prototype consumes HOBO-550 support workflow mockups, keeps
redacted evidence explicit, and blocks runtime support or customer-data work
from entering this proof.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibeSupportCaseRedactedEvidence` checks the raw support case fixture at
the boundary and returns `ParsedVibeSupportCaseRedactedEvidence`. Downstream
proof code consumes the parsed domain type rather than passing raw strings and
rechecking mockup refs, redacted logs, incident refs, support refs, admin
context, docs source, proof package link, redaction state, next update
condition, and proof mode in every view.

## Event Architecture

This package does not implement support runtime. It names the event model later
runtime work must preserve:

- **Command** - `supportCasePrototype.Accept` records an accepted support case
  evidence pack.
- **Event** - `supportCasePrototype.Accepted` appends consumed HOBO-550 mockup
  refs, redaction state, owner route, scenario, proof-mode, and accessibility
  evidence.
- **Actor** - `SupportCasePrototypeActor` owns the parsed evidence pack and
  rejects helpdesk, support queue, customer-data, incident-command, on-call,
  production UI, SLA, or unsupported launch-claim creep.
- **Event store** - accepted support case evidence is appended to the platform
  event store as design-time evidence.
- **Materialized view / projection** - `SupportCasePrototypeView` folds
  accepted events into the read model consumed by later support or launch-demo
  slices.
- **Snapshot** - the parsed HOBO-564 record is replayable from its accepted
  event and carries redaction and proof-mode labels.
- **Read store** - later support implementation reads the snapshot, not issue
  body text or live support ticket state.

No helpdesk software, ticket queue automation, production support UI,
customer-data access, incident command, on-call staffing, notification dispatch,
contractual SLA promise, or unsupported launch claim is implemented here.
