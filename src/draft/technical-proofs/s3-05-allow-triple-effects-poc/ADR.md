# Allow Triple Effects — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted `.allow()`
declarations are parsed once at the boundary into derived domain types
(`AllowDeclaration`, `AllowTripleEffects`, `TokenScopeCeiling`), and downstream
consumers receive those parsed, derived types instead of re-checking raw input.
The CUE constraints bound the same derived types so malformed input is rejected
at parse time rather than passed downstream.

`compileAllowTripleEffects` is the sole parse boundary; invalid verbs or ports
throw `AllowTripleEffectsError` and cannot be represented as triple effects.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — `RequestProviderToken` requests a brokered token scoped to a
  resource verb within the `.allow()` ceiling.
- **Event** — successful grants emit `token.Granted`; over-scope requests emit
  `token.Denied` audit events via `identity-event-contract`.
- **Actor** — the identity broker actor applies token grant/deny decisions in
  order against the compiled ceiling read model.
- **Event store** — accepted token events are appended to the platform event
  store as the durable source of truth.
- **Materialized view / projection** — a projection folds token grant/deny events
  into the credential audit read model.
- **Snapshot** — `TokenScopeCeiling` compiled from `.allow()` is the snapshot of
  the permission projection consumed by the broker.
- **Read store** — downstream surfaces query that read store rather than the
  raw event log.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
