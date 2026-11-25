# Broker Admin Controls Contract - Architecture Evidence

This draft package carries the architecture-guard evidence for HOBO-527. It proves the admin
control boundary for broker environment proposals and approvals without implementing the Admin
Console UI, hosted broker runtime, Yard planner, provider adapters, or Gatekeeper policy runtime.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/broker_admin_controls.proto`](./architecture/broker_admin_controls.proto).
- CUE constraints live in [`architecture/broker_admin_controls.cue`](./architecture/broker_admin_controls.cue).
- A Pact-style boundary fixture lives in
  [`architecture/pacts/broker_admin_controls.pact.json`](./architecture/pacts/broker_admin_controls.pact.json).

## Parse, Don't Validate

Untrusted admin-control input is parsed once at the boundary into derived domain types for actor,
proposal, approval, audit evidence, environment snapshot, and receipt reference. Downstream code
receives parsed broker-admin actions and accepted events instead of repeatedly checking raw strings.

## Event Architecture

The accepted record maps onto an event-sourced control flow:

- **Command** - `BrokerAdminControlCommand` requests proposal, approval, revocation, or rejected
  receipt mutation.
- **Event** - `BrokerEnvironmentProposalRecorded`, `BrokerEnvironmentSnapshotApproved`, or
  `BrokerEnvironmentSnapshotRevoked` is appended for accepted changes.
- **Actor** - a broker admin-controls actor serializes proposal and approval decisions per Broker
  Environment.
- **Event store** - accepted events append to the broker admin-controls event store as durable
  evidence.
- **Projection** - support, security, and admin read models fold the event stream into proposal
  status, approval lineage, and receipt immutability views.
- **Snapshot** - Broker Environment snapshots preserve approved versioned input state.
- **Read store** - Admin Console and support surfaces query read stores, not raw command payloads.

No runtime workflow, projector, storage backend, Admin Console route, hosted broker resolver, Yard
planner, provider adapter, or policy engine is implemented here.
