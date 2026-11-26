# Entitlement Abuse Rate-Limit Policy - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the parse-don't-validate discipline: untrusted policy input is parsed once at
the boundary into derived policy records, and downstream consumers receive those parsed records
instead of re-checking raw DTOs. The CUE constraints bound the same derived types so malformed
policy evidence is rejected at parse time.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- Command - a request to record or amend the accepted HOBO-491 policy state.
- Event - a successful command appends an `entitlement.policy.*` fact to the log.
- Actor - the Entitlements & Plan Limits policy aggregate applies policy events in order.
- Event store - accepted policy events are appended as the durable source of truth.
- Materialized view / projection - a projection folds policy events into the queryable policy
  record.
- Snapshot - the accepted HOBO-491 record is the snapshot of that projection.
- Read store - downstream support, security, billing, and quota surfaces query the read store rather
  than the raw event log.

No runtime engine, projector, rate limiter, fraud scorer, billing provider, or support workflow is
implemented here; this is a design-time contract that names the command, event, actor, projection,
and scope boundaries.
