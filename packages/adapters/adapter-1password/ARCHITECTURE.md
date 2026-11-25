# Architecture — `@hobo/adapter-1password`

## Shape

```
official SDK client (injected) ──► OnePasswordSdkClient ──► createOnePasswordSecretsPort (kind "1password")
                                  (items.list / items.get / items.create / items.put)      access / accessVersion / put / listVersions
```

- `binding.ts` is the parser for the non-secret coordinates. Parse, don't
  validate: past `parseOnePasswordBinding` code holds the derived type `ParsedOnePasswordBinding`, and
  secret names pass `parseOnePasswordSecretName` once; neither is ever a raw string again.
- `sdk-port.ts` names the part of the vendor SDK's client the adapter calls;
  the SDK is not a dependency.
- `secrets-port.ts` adapts that client to `@hobo/identity`'s `SecretsPort`:
  one Password item per secret in the bound vault. It never logs, and `OnePasswordError` carries an operation and a code only.

## Events, commands and state

The adapter is a boundary client: it accepts no command, emits no events, and
owns no event store, actor, projection (materialized view), snapshot or read
store. It holds no state at all; the history of a secret is 1Password's item history,
which callers treat as an external read store. `secret.Accessed` audit events
stay the caller's (`@hobo/identity`), carrying references only.

## Secretless first

1Password signs a workload in with a stored token (ADR-0179 amendment
"Secretless first", checked 2026-11-12), so HoBo never makes it the hosted
relay's runtime store; routing in `@hobo/secret-store-claim` records it as
`runtimeAuth: "stored-token"` and passes over it. It serves the owner's side.
