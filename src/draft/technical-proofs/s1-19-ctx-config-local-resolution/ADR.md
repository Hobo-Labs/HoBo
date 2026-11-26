# S1-19 ctx.config local resolution — Architecture Evidence

Draft package architecture-guard evidence for HOBO-609.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- PACT contracts under [`architecture/pacts/`](./architecture/pacts) record service boundaries.

## Parse, Don't Validate

Untrusted config declarations cross one parser boundary (`config()`, `secretRef()`,
`env()`, `fromBinding()`) and become derived domain types (`ConfigContract`,
`ConfigEntry`, `SecretValue`). Downstream resolver and context modules accept
parsed types only; CUE constraints reject malformed manifest and event records at
parse time.

## Event Architecture

Config resolution is append-only audit over the local Camp event store:

- **Command** — `resolveConfigKey` requests resolution for a declared config entry.
- **Event** — successful resolution appends `config.Resolved`; secret access appends
  `secret.Accessed`; failures append `secret.Unavailable`.
- **Actor** — the runtime config resolver actor applies resolution commands and emits
  audit events; it never mutates a query read model directly.
- **Event store** — `createInMemoryEventStore` appends scrubbed events before persistence.
- **Materialized view / projection** — no config-value projection is built; audit events
  are the durable facts consumers replay.
- **Snapshot** — current Camp config values are read from the Camp config record snapshot
  for `camp-env` keys only.
- **Read store** — tests query appended events, logs, spans, and stream frames as read
  stores for redaction conformance.

No brokered-token rungs are implemented in this slice; production promotion wires the
same boundaries into `@hobo/runtime` and `@hobo/runtime-local`.
