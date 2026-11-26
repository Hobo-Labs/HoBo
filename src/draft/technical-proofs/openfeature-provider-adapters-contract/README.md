# OpenFeature Provider Adapters Contract

Executable POC for HOBO-361. It proves the adapter boundary for opt-in
OpenFeature providers without adding production vendor SDKs, governance UI, or
the built-in flag store itself.

## Scope

- `flagd`, LaunchDarkly, and Unleash adapter wrappers for the
  `hobo:feature-flag` provider sub-port.
- Per-Camp provider selection through Matching config.
- HoBo `PrincipalRef` evaluation-context mapping for each provider shape.
- Shared conformance against the same boolean, string, number, object,
  targeting, and default behavior used by the built-in store.
- Fail-safe behavior for provider outage, timeout, type mismatch, and
  vendor-key collision.

## Out of Scope

- Built-in flag store implementation.
- `ctx.flags` or `useFlag` SDK ergonomics.
- Delivery, experiment, and governance UI adapters.
- Real vendor SDK initialization and credential handling.

## Verification

```text
npm.cmd --prefix src\draft\technical-proofs\openfeature-provider-adapters-contract test
```

The focused test suite covers all HOBO-361 acceptance and adversarial cases.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Openfeature Provider Adapters Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
