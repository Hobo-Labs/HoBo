# Customer Onboarding Script Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its script data is parsed and how its
records map onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies parse-don't-validate discipline: customer onboarding input is parsed once into
the `ParsedCustomerOnboardingScript` derived type, a bounded pilot note route, or a future-use gate.
Downstream release, support, docs, and product UX surfaces consume those parsed derived types instead
of re-checking raw notes.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- Command - a request to record or change the accepted first-customer onboarding script.
- Event - a successful command appends a `customerOnboarding.ScriptAccepted` event.
- Actor - the Customer Onboarding scope actor applies accepted script events in order.
- Event store - accepted events are appended to the platform event store as the durable source of
  truth.
- Materialized view / projection - a projection folds accepted events into the script read model
  used by release, support, docs, and product UX surfaces.
- Snapshot - the accepted script contract is the snapshot of that projection.
- Read store - downstream surfaces query the read store rather than the raw event log.

No runtime engine, projector, support queue, customer-success platform, or event store is
implemented here; this is a design-time contract that names the command, event, actor, projection,
and scope boundaries so later implementation inherits a consistent vocabulary.
