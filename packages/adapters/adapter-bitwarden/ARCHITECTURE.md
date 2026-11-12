# Architecture — `@hobo/adapter-bitwarden`

## Shape

```
official SDK client (injected) ──► BitwardenSdkClient ──► createBitwardenSecretsPort (kind "bitwarden")
                                  (secrets().list / get / create / update)      access / accessVersion / put / listVersions
```

- `binding.ts` is the parser for the non-secret coordinates. Parse, don't
  validate: past `parseBitwardenBinding` code holds the derived type `ParsedBitwardenBinding`, and
  secret names pass `parseBitwardenSecretName` once; neither is ever a raw string again.
- `sdk-port.ts` names the part of the vendor SDK's client the adapter calls;
  the SDK is not a dependency.
- `secrets-port.ts` adapts that client to `@hobo/identity`'s `SecretsPort`:
  one secret per key in the bound project. It never logs, and `BitwardenError` carries an operation and a code only.

## Events, commands and state

The adapter is a boundary client: it accepts no command, emits no events, and
owns no event store, actor, projection (materialized view), snapshot or read
store. It holds no state at all; the history of a secret is Bitwarden's revision dates,
which callers treat as an external read store. `secret.Accessed` audit events
stay the caller's (`@hobo/identity`), carrying references only.

## Secretless first

Bitwarden Secrets Manager signs a workload in with a stored token (ADR-0179 amendment
"Secretless first", checked 2026-11-12), so HoBo never makes it the hosted
relay's runtime store; routing in `@hobo/secret-store-claim` records it as
`runtimeAuth: "stored-token"` and passes over it. It serves the owner's side.
