# HoBo feature-flag port POC

This draft implements HOBO-299: the OpenFeature-compatible `hobo:feature-flag`
port contract. It is intentionally isolated from the future product monorepo.

## Scope

- WIT package `hobo:feature-flag@0.1.0`.
- Four typed detailed-evaluation methods: boolean, string, number, object.
- Evaluation context carrying HoBo `PrincipalRef` for `ctx.user` and
  `ctx.identity`, plus targeting attributes.
- Provider sub-port and hook seam.
- Fail-safe default-on-provider-error behavior captured by conformance tests.

WIT does not accept recursive JSON value definitions through `jco types`, so
object flags cross the WIT boundary as encoded JSON. The conformance harness
still rejects non-JSON-safe object values and fails safe to the caller default.

## Out of scope

- Built-in flag store.
- SDK ergonomic surface (`ctx.flags`, `useFlag`).
- OpenFeature provider adapters.
- Targeting rule engine.

## Verification

```powershell
npm.cmd install
npm.cmd test
```

`npm.cmd test` runs `jco types` against `wit/world.wit`, then executes the
Node conformance tests.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Feature Flag Port.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
