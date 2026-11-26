# Architecture — `@hobo/provider-config`

Optional linked **`wasi:config/store`** capability provider (ADR-0142).
Import-optional: no always-on config or vault service when components do not
import config. **Not** a residual secrets warehouse.

## Schema and constraints

- Protobuf: [`data-models/provider_config.proto`](./data-models/provider_config.proto)
- CUE: [`data-models/provider_config.cue`](./data-models/provider_config.cue)
- PACT: [`contracts/provider-config-boundary.pact.json`](./contracts/provider-config-boundary.pact.json)

## Parse, don't validate

Parse, don't validate: `get` returns derived domain types shaped as
`{ key, value-ref, sensitivity }`. Sensitive plaintext is rejected at `put`.
Host-only `materialize(valueRef)` is outside the guest WIT surface.

## Event architecture

- **Command** — put/get config keys for a Camp (when imported).
- **Event** — upstream `config.Resolved` (refs + sensitivity only) from identity.
- **Actor** — none owned; Camp/host links this provider on demand.
- **Event store** — platform credential-audit / config stream, not local vault.
- **Materialized view / projection** — none; latest-value map is process-local.
- **Snapshot** — in-memory key map (dev) or durable adapter (Camp profile).
- **Read store** — `get` / `listKeys` for host and linked guests (refs only).
