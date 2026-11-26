# ADR — `@hobo/adapter-openbao`

## Status

Accepted

## Context

Residual secrets (ADR-0027 / ADR-0113) need an optional OpenBao backend for
Camps that still operate classical secret stores. Default installs and
`@hobo/identity` must stay secretless-first with **memory** as the built-in
local residual — not OpenBao.

## Decision

Ship OpenBao support as an **optional L2 adapter** under `packages/adapters/`:

- Package name: `@hobo/adapter-openbao`
- Depends on `@hobo/identity` only for the `SecretsPort` types
- Exports `createOpenBaoSecretsPort` / `createLocalStationOpenBaoSecretsPort`
- Does **not** live in `@hobo/identity` or the composed `hobo` default deps
- Auth is short-lived SVID JWT only; never a long-lived OpenBao/Vault root token
- Offline mode is deterministic HMAC for `hobo dev` / tests

## Consequences

- Default residual: `createMemorySecretsPort` / `createLocalStationSecretsPort`
  (memory)
- Installers that want residual OpenBao take an explicit dependency on
  `@hobo/adapter-openbao`
- `HOBO_LOCAL_SECRETS_BACKEND=openbao` fails closed with an install hint
