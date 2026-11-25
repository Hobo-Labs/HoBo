# Architecture — `@hobo/adapter-openbao`

Optional residual [OpenBao](https://openbao.org) `SecretsPort` adapter.
**Not** a default dependency of `@hobo/identity` or the composed `hobo`
binary. Default residual installs use **memory**.

## Schema and constraints

- Protobuf: [`data-models/adapter_openbao.proto`](./data-models/adapter_openbao.proto)
- CUE: [`data-models/adapter_openbao.cue`](./data-models/adapter_openbao.cue)
- PACT: [`contracts/pacts/openbao-secrets-boundary.pact.json`](./contracts/pacts/openbao-secrets-boundary.pact.json)

## Parse, don't validate

Parse, don't validate: untrusted residual access options (addr, role, SVID JWT,
mount, namespace, offline flag) cross one boundary at
`createOpenBaoSecretsPort` / `createLocalStationOpenBaoSecretsPort`. Callers
receive derived domain types from `@hobo/identity` (`SecretsPort`,
`SecretsAccessResult` with `valueRef` + optional short-lived `material`) —
not raw OpenBao HTTP bodies re-checked at every call site. Live responses are
parsed once into ref/version/lease fields; offline mode derives deterministic
HMAC material and refs only. Plaintext never appears in audit events or
contract fixtures (`requireNoPlaintextConformance`).

## Residual ranking (unchanged)

bound-resource → **provider-federation** (this adapter) → camp-value →
static-escape. Prefer secretless federation; OpenBao is residual only
(ADR-0027 / ADR-0113).

## Event architecture

This adapter does not own a control-plane aggregate. It implements residual
`SecretsPort` for Camps / local Station hosts that opt in.

- **Command** — residual `put` / `access` / `accessVersion` / `listVersions`
  against OpenBao (JWT login + KV v2) or offline HMAC path.
- **Event** — upstream `@hobo/identity` emits refs-only `secret.Accessed` /
  `config.Resolved` (never-compact CredentialAudit). This package never emits
  plaintext values into the event stream.
- **Actor** — none owned here; residual access is invoked by Camp / Station /
  config-resolver actors in identity and runtime packages.
- **Event store** — credential-audit stream on the platform EventStore
  (identity package), not an OpenBao-local journal.
- **Materialized view / projection** — credential-audit projection folds
  `secret.Accessed` by correlation; secrets material is never projected.
- **Snapshot** — optional short-lived JWT client-token cache in-process only
  (not durable; not an audit snapshot).
- **Read store** — KV v2 version list via OpenBao metadata API (live) or
  in-process version map (offline); agents see schema/ref views only.

## Boundaries

| Surface | Direction |
| --- | --- |
| `@hobo/identity` `SecretsPort` | provider implements residual port |
| OpenBao auth/jwt + KV v2 HTTP | live residual backend (injected `fetch`) |
| Offline HMAC | network-free residual for `hobo dev` / tests |
