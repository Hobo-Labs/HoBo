# @hobo/wit

Production WIT toolchain package for HoBo. Vendors and pins reused `wasi:*` interfaces, publishes first-party `hobo:runtime` primitives plus async capability ports (`hobo:queue`, `hobo:scheduler`, `hobo:blob-events`), and ships the import-only `hobo:sdk@0.1.0` aggregate world with deterministic jco bindings.

## Layout

- `wit/hobo-sdk.wit` — canonical `hobo:sdk@0.1.0` aggregate (`world sdk` imports only; ADR-0072).
- `wit/deps/hobo-*` — first-party interface packages (`hobo:runtime`, queue, scheduler, blob-events).
- `wit/deps/wasi-*` — vendored `wasi:*` WIT sources with SHA-256 pins recorded in `wit-lock.json`.
- `wit-lock.json` — schema `hobo.wit-toolchain-lock/v1`; exact toolchain floor per ADR-0085.
- `src/generated/` — jco-emitted `.d.ts` bindings per world (never hand-edited; regenerate with `pnpm wit:gen`).
- `data-models/` — protobuf + CUE records for lock, pins, surfaces, and parity reports.

## Commands

```bash
pnpm --filter @hobo/wit run wit:gen              # regenerate bindings
pnpm --filter @hobo/wit run wit:check            # fail on binding drift (ADR-0037)
pnpm --filter @hobo/wit run codegen              # alias for wit:gen
pnpm --filter @hobo/wit run roundtrip            # forward↔reverse surface parity
pnpm --filter @hobo/wit test
```

## Lock ceremony

1. Vendored WIT lives under `wit/deps/` and the aggregate under `wit/hobo-sdk.wit`.
2. `wit-lock.json` records each pin as `namespace:package/interface@semver@stability` plus `sha256:` digest.
3. `verifyVendoredWit` fails closed on digest mismatch before any pin can be used.
4. jco `@bytecodealliance/jco@1.24.3` is the canonical TS binding generator; `wit-bindgen-cli@0.58.0` is compatibility-smoke only.

## Parse, don't validate

`verifyVendoredWit` parses `wit-lock.json` into derived types (typed pin records with
`sha256:` digests) and fails closed on mismatch — consumers never see an unverified pin. The
roundtrip parity check likewise parses generated binding surfaces into derived comparison
records rather than validating raw text. Wire forms for the lock, pins, surfaces, and parity
reports live in `data-models/` as protobuf with CUE constraints.

## Position in the event architecture

`@hobo/wit` is build-time tooling: it defines the WIT membrane that runtime actors' commands and
events cross, but it hosts no actor, appends nothing to an event store, and serves no runtime
read store. Its records are snapshots, not streams — `wit-lock.json` is a versioned snapshot of
the vendored toolchain, and parity reports are a derived projection (a materialized view of the
generated surface) recomputed by `wit:check`, never mutated in place.

## Upgrade rules

Preview stability bumps require ADR-0085 ceremony artifacts before merge:

- upcaster for the breaking preview change
- new Bindle version
- deprecation window

CI guard `preview-bump-declares-upcaster` rejects preview pin changes lacking those markers.

## References

- [Plan 20 — WIT interface catalog](../../docs/design/wasm-runtime-wit.md#plan-20)
- [ADR-0072 — SDK is WIT-first](../../docs/design/adr/01-architecture-core.md#adr-0072)
- [ADR-0085 — wRPC + WIT baseline](../../docs/design/adr/01-architecture-core.md#adr-0085)
- [ADR-0024 — exact upstream pins](../../docs/design/adr/07-portability-extensibility.md#adr-0024)

Promoted from draft proofs `hobo-wit-toolchain-contract`, `hobo-sdk-aggregate-wit-contract`, `hobo-runtime-primitives`, and `wasi-interface-pins` (HOBO-583, HOBO-590).
