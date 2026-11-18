# HOBO-3 WIT Toolchain Contract

This POC proves the M0 `@hobo/wit` contract for HOBO-3:

- `wit/hobo-sdk.wit` defines the canonical `hobo:sdk@0.1.0` WIT package skeleton.
- `toolchain-lock.json` pins the WIT generation floor and every vendored WIT dependency by SHA-256.
- `pnpm wit:gen` emits checked-in TypeScript declarations from the WIT package, and `pnpm wit:check` fails on drift.
- `fixtures/trivial-guest.ts` imports the generated `hobo:sdk` world and builds as a trivial guest.
- The trivial guest compile proof invokes the package-local TypeScript compiler through a shell-safe path so Windows does not directly spawn `.cmd` shims.

The compatibility floor is documented against [Plan 20](urn:hobo:requirement:wasm-runtime-wit#plan-20), [ADR-0072](urn:hobo:decision:adr-0072), [ADR-0037](urn:hobo:decision:adr-0037), and the version-pinning policy in [ADR-0024](urn:hobo:decision:adr-0024). Runtime primitive contents stay out of this package; downstream runtime slices own filling those interfaces.


## Executable evidence
This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Wit Toolchain Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
