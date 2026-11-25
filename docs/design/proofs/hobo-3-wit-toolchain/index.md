# HOBO-3 WIT Toolchain Proof

HOBO-3 is proven by the focused POC at [`src/draft/technical-proofs/hobo-wit-toolchain-contract`](../../../../src/draft/technical-proofs/hobo-wit-toolchain-contract/README.md).

**Promoted to production:** [`packages/wit`](../../../../packages/wit/README.md) (`@hobo/wit`, HOBO-583).

Acceptance mapping:

- `wit:gen` determinism is checked by the package test and `pnpm wit:check`.
- The trivial guest fixture imports the generated `hobo:sdk` world and builds.
- The WIT compatibility floor is recorded in the toolchain lock with an explicit [ADR-0024](../../adr/07-portability-extensibility.md#adr-0024) policy link.

Scope note: this proof defines only the `hobo:sdk` package skeleton and deterministic generation contract. Runtime primitive and capability interface contents remain owned by downstream Plan 20 slices such as [ADR-0072](../../adr/01-architecture-core.md#adr-0072) runtime work.
