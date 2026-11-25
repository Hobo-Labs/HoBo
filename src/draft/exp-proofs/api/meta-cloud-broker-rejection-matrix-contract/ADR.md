# Meta-cloud Broker Rejection Matrix Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the consumer/provider
  boundary for structured rejection outcomes.

## Parse, Don't Validate

Untrusted rejection fixtures cross one parser boundary into parsed derived domain types for broker
rejection scenarios. Downstream matrix evaluation receives parsed case IDs, digest replay inputs,
blocked-optimism classes, and customer-safe support evidence instead of raw debug DTOs. Raw secrets,
tokens, customer payloads, and provider-specific debug material are intentionally discarded at parse
time so they cannot become durable rejection facts.

## Event Architecture

The package names the event-driven contract without implementing the hosted broker runtime:

- **Command** - `EvaluateBrokerRejectionMatrix` requests M3 adversarial rejection evidence for a
  manifest digest against a Broker Environment and Broker Catalog Snapshot digest.
- **Event** - rejected commands append `broker.ResolutionRejected` with the rejection matrix case,
  reason code, replay inputs, support evidence, digest, and signature.
- **Actor** - the Meta-cloud Broker rejection aggregate is the single writer for rejection identity,
  digest computation, and support-safe evidence projection.
- **Event store** - rejection matrix facts are durable broker authority evidence.
- **Materialized view / projection** - a support/security projection folds rejection facts into
  customer-safe debugging state.
- **Snapshot** - Broker Environment and Broker Catalog Snapshot digests are immutable replay inputs.
- **Read store** - Yard, support, and security surfaces read rejection facts instead of re-running
  broker authority or Yard-local matching.

No hosted service, Yard planner, Matching engine, provider adapter, Admin Console flow, Gatekeeper
engine, provider-specific live remediation, or live provider call is implemented here. This is an
adversarial contract proof for the M3 broker rejection boundary.
