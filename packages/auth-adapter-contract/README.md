# `@hobo/auth-adapter-contract`

Better Auth **adapter planning contract**: versioned ids, locator-only config
parse, required ports descriptor, and the runtime gate vocabulary shared by
`@hobo/adapter-better-auth` and `@hobo/pack-better-auth`.

Parse, don't validate: `BetterAuthConfig`, `BetterAuthSecretRef`, and
`AuthAdapterDescriptor` are **parsed derived types** minted only at the config
and locator boundaries.

## Commands, events, and durability

Stated explicitly rather than left silent: this package is a **parse boundary**
only. It has no lifecycle.

- **Command / event.** No `command` handler here. Durable `auth.BundlePlanned`
  events are emitted by the pack **actor** in follow-up PRs once materialization
  exists.
- **Actor and event store.** No actor and no **event store** writer in this
  package. Host apps use `@hobo/storage-sqlite` when execution lands.
- **Projection, snapshot, read store.** No **materialized view**, **projection**,
  **snapshot**, or **read store** maintenance here. `@hobo/pack-better-auth`
  `toBetterAuthBundlePlanRecord` is the durable **projection** helper consumed
  by the host's read store.

## Contracts and data models

- `data-models/auth_adapter_contract.{proto,cue}` — durable config record shape.
- `contracts/pacts/auth-adapter-config-boundary.pact.json` — config parse boundary.
- `test/contract.test.ts` — provider verification against the pact file.