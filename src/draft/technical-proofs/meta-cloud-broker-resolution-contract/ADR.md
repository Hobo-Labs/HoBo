# Meta-cloud Broker Resolution Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the consumer/provider
  boundary for receipt and rejection outcomes.

## Parse, Don't Validate

Untrusted Contract Manifest and Broker Environment inputs cross one parser boundary into derived
domain types for resolution. Downstream resolution code receives parsed domain types for manifest
resources, approved mapping contracts, catalog capabilities, and immutable replay inputs instead of
raw DTOs plus repeated boolean checks. CUE constraints define the same derived objects so malformed
or ownerless broker artifacts are rejected before they can become durable receipt or rejection facts.

## Event Architecture

The package names the event-driven contract without implementing the hosted broker runtime:

- **Command** - `ResolveContractManifest` requests deterministic resolution for a manifest digest
  against a broker environment digest.
- **Event** - successful commands append `broker.ResolutionReceiptIssued`; rejected commands append
  `broker.ResolutionRejected`.
- **Actor** - the Meta-cloud Broker resolution aggregate is the single writer for receipt/rejection
  identity and digest computation.
- **Event store** - issued receipts and rejections are durable broker authority facts.
- **Materialized view / projection** - a support/security projection folds receipt and rejection
  facts into customer-safe explainability state.
- **Snapshot** - the Broker Environment digest is the immutable snapshot input for replay.
- **Read store** - Yard, support, and security surfaces read receipt/rejection facts rather than
  re-running broker authority locally.

No hosted service, Yard planner, Matching engine, provider adapter, Admin Console flow, Gatekeeper
engine, or live provider call is implemented here. This is a deterministic contract proof for the
M2 broker-resolution boundary.
