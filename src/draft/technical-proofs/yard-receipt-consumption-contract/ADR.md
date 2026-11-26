# Yard Receipt Consumption Contract - Architecture Evidence

HOBO-523 proves the Control Plane/Yard side of the Meta-cloud Broker boundary. This package does
not implement the hosted broker runtime, full Planner, Matching engine, provider adapters, admin UI,
or Gatekeeper policy engine. It proves that Yard consumes a broker-issued Resolution Receipt as
evidence and fails closed instead of silently re-resolving hosted broker authority.

## Schema Sources Of Truth

- **Protobuf** - `architecture/yard_receipt_consumption.proto` defines the `ResolutionReceipt`,
  `YardPlanningInput`, `ReceiptHandoffFacts`, `ResourcePlan`, `GatekeeperDecision`, and
  `ReceiptFailureCode` messages/enums.
- **CUE** - `architecture/yard_receipt_consumption.cue` constrains every protobuf type, including
  signed receipt ownership, compatibility, non-empty handoff facts, and failure codes.
- **PACT** - `architecture/pacts/yard_receipt_consumption.pact.json` pins the boundary between the
  Meta-cloud Broker receipt issuer and the Yard receipt consumer.

## Parse, Don't Validate

Raw receipt JSON is parsed once at the Yard boundary into a `ParsedResolutionReceipt` derived domain
type. The parser checks broker issuer, digest, signature, expiration, protocol compatibility, and
resource-plan shape. Yard planning functions accept the parsed receipt-derived `YardPlanningInput`
instead of raw DTOs, so tampered, stale, incompatible, or proofless receipts are unrepresentable
past the boundary.

## Event Architecture

- **Command** - `ConsumeResolutionReceipt` asks the Yard receipt consumer to accept broker evidence
  for a manifest/environment pair.
- **Events** - valid receipts emit `ReceiptConsumedForPlanning`; invalid receipts emit
  `ReceiptRejectedForPlanning`.
- **Actor** - the Yard receipt-consumer actor is the single writer for receipt-consumption decisions
  per Yard and receipt id.
- **Event store** - receipt consumption and rejection events append to the Yard control-plane
  event-store.
- **Materialized view / projection** - a projection builds receipt handoff status by manifest digest,
  environment digest, and receipt id for Planner and support use.
- **Snapshot** - snapshots bound replay cost for long-running receipt handoff histories without
  changing broker-issued receipt authority.
- **Read store** - the support/operator read store exposes customer-safe receipt-consumption and
  rejection metadata, never mutable broker internals.

Gatekeeper remains downstream of receipt consumption. It can block or require obligations, but it
cannot rewrite receipt mappings; a changed mapping requires a new broker receipt or explicit policy
decision evidence.
