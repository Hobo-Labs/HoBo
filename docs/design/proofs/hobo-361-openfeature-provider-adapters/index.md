# HOBO-361 OpenFeature Provider Adapters Proof

This proof connects the M2 provider-adapter slice to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [docs/standards/openfeature.md](../../../standards/openfeature.md)
- [ADR-0033](../../adr/01-architecture-core.md#adr-0033)
- [ADR-0044](../../adr/02-identity-security.md#adr-0044)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/openfeature-provider-adapters-contract`](../../../../src/draft/technical-proofs/openfeature-provider-adapters-contract)

Acceptance evidence:

- `flagd`, LaunchDarkly, and Unleash adapters implement the same
  OpenFeature-shaped `get*Details` provider methods as the built-in store.
- The shared conformance suite proves boolean, string, number, and object flag
  values, PrincipalRef targeting, and missing-flag defaults.
- Matching config switches a Camp from the built-in provider to `flagd` without
  changing the application call site.
- `PrincipalRef` maps into `flagd`, LaunchDarkly multi-context, and Unleash
  context shapes.
- Provider outage and hung-provider timeout return caller defaults instead of
  throwing to callers.
- Type-mismatched vendor values default safely.
- Vendor flag-key collisions with HoBo-defined flags are rejected.

Scope boundary:

- No production vendor SDK wiring or credentials.
- No delivery or experiment adapters.
- No governance UI.
