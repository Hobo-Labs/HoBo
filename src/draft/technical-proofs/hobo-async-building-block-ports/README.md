# HoBo async building-block ports POC

> **Promoted to production:** `hobo:queue`, `hobo:scheduler`, and `hobo:blob-events` capability interfaces now ship from [`packages/wit/wit/deps/`](../../../../packages/wit/wit/deps/) (`@hobo/wit`, HOBO-590).

This draft implements HOBO-14: the `hobo:queue`, `hobo:scheduler`, and
`hobo:blob-events` WIT capability-interface contracts. It is intentionally
isolated from the future product monorepo.

## Scope

- `hobo:queue@0.1.0` pull-queue contract with at-least-once delivery,
  idempotency keys, visibility timeout, lease handles, lease extension, and
  release/complete operations.
- `hobo:scheduler@0.1.0` interval and cron trigger contract.
- `hobo:blob-events@0.1.0` bucket notification filters and presigned upload /
  download URL contracts.
- A guest-import world for each interface so `jco types` emits typed bindings.
- A TypeScript guest stub that imports all three generated worlds and compiles.

## Out of scope

- Provider implementations backing the interfaces.
- Queue runtime-port storage semantics.
- Presigned URL signing logic.
- Scheduling engine execution.

## Verification

```powershell
npm.cmd install
npm.cmd test
```

`npm.cmd test` runs `jco types` for all three WIT packages, then executes the
TypeScript guest-stub compile gate and Node conformance tests.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Async Building Block Ports.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
