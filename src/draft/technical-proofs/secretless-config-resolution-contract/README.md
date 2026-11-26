# HoBo secretless config resolution contract

Independent POC for HOBO-222. It composes the existing config schema,
identity-event, and OIDC federation draft contracts into a narrow runtime
resolver for the [Plan 21](../../../../docs/design/authoring-resources-wiring.md#plan-21)
secretless-first ladder from [ADR-0027](../../../../docs/design/adr/02-identity-security.md#adr-0027).

> **Promotion note (S1-19 / HOBO-609):** local-Camp resolution + redaction-at-capture draft POC at
> `src/draft/technical-proofs/s1-19-ctx-config-local-resolution/`. Production target:
> `packages/runtime/src/config/` and `packages/runtimes/runtime-local/src/secrets-dev.ts`.

## Contract surface

- `fromBinding(...)` entries resolve through a brokered provider token and do
  not read a secret.
- `secretRef(...)` entries with provider federation broker a scoped token, read
  from the Camp's `secrets` port adapter at use-time, emit `secret.Accessed`,
  and keep the value wrapped in memory only.
- `env(...)` entries resolve non-secret values from Camp config.
- Secret values are redacted by `SecretValue` serialization and by
  `assertNoPlaintextConformance(...)` across Bindle, Camp, event, log, and span
  surfaces.
- A provider without federation routes to the bounded static-secret hatch
  without implementing or reading that hatch.
- The `secrets` adapter is selected from Camp metadata, so swapping providers
  requires no app declaration edit.

## Proof boundaries

This package does not implement typed `ctx.config` codegen, the static-secret
escape hatch hardening, IaC-state secret reference migration, or the OIDC
exchange internals. The token request shape is consumed from the HOBO-110
OIDC-federation proof.

## Executable checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\secretless-config-resolution-contract test
```

The tests cover ladder paths (a)-(c), event joins, no-plaintext conformance,
static-hatch routing, and provider adapter swapping.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Secretless Config Resolution Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
