# @hobo/fuzz architecture

`@hobo/fuzz` owns **oracles**, not production control-plane state. Production
packages stay the source of parse/hash/apply behavior; this package drives
them through ports and an in-memory ledger.

```
fast-check command traces  -->  ControlModel  -->  InvariantVerdict
serialized buffers         -->  Jazzer harness -->  parse-or-reject + pollution
OpenAPI / GraphQL (opt.)   -->  Schemathesis   -->  ephemeral @hobo/control-api
nightly sequences          -->  RESTler        -->  docker-gated simulators
faults                     -->  Toxiproxy      -->  Testcontainers deps
```

Records: `InvariantVerdict` / `FuzzTrace` are documented in
`data-models/fuzz.proto` + `fuzz.cue`. The TypeScript verdict is a domain view
over that wire shape (`// domain-view`). The package is not opted into
codegen (`data-models/` has no `buf.yaml`).

Parse, don't validate: untrusted manifests, policy documents, and API bodies
cross one parser (`parseManifest` / `parseOrReject` / `handleControlRequest`)
and become derived domain types (`ManifestV1` or a rejected sentinel).
Harnesses never re-check raw DTO fields after that boundary.

This package is not an actor runtime. In the platform pipeline, apply/retry/
rollback **commands** are handled by control-plane **actors** that append to
the durable **event store**; **materialized views** / **projections** and
cached **snapshots** feed the **read store**. `ControlModel` is the in-memory
oracle of that fold: commands append events, `snapshot()` pins a clock, and
`replay()` rebuilds state from history.

Commands emit an append-only event log. `replay()` folds the log onto a fresh
model and compares fingerprints. Tenant isolation is fail-closed: bindle ids,
capability ids, and idempotency keys do not overwrite another tenant, and
`changeTenant` is refused.

Gates: package Vitest (`test`, `test:property`, `test:fuzz`), root
`pnpm run test:property`, architecture guard + konsistent on this package,
PACT fixture under `contracts/`, docs in `docs/design/fuzzing.md`.
