# WIT Port Stub Contract POC

Independent draft POC for **HOBO-651** (S5-06): productionize `stub()` so any WIT
port can be backed by a typed stub that records calls as events and returns
schema-valid responses.

## Requirements Source

- `urn:hobo:requirement:generated-stack#plan-23` — stub semantics, partial overrides, trace-as-spec
- `urn:hobo:decision:adr-0076` — `mock` boundary mode, `stub.Recorded`
- `urn:hobo:requirement:event-families` — `stub.*` family

## Contract Surface

- `stub({ membrane, componentId, portInterface, portSchema, overrides? })` — link typed mock provider (Plan 23 SDK shape stand-in)
- `exportRecordedTrace(membrane)` — replayable trace for Camp event store
- `replayRecordedTrace({ membrane, trace, adapter })` — S1-12 harness stand-in
- `createPaymentsPortSchema()` — reference WIT port fixture for checkout scenario

## What This Proves

- Reference checkout app runs with `payments` port stubbed end-to-end
- Each call emits `stub.Recorded` + `link.Called` with `boundaryMode: "mock"`
- Exported trace replays deterministically; divergence fails closed
- Partial per-operation overrides work (`charge: () => ({ status: "declined", ... })`)
- Schema-invalid stub responses rejected at boundary

## Scope Boundary

Does not promote into `packages/runtime/`, wire Camp persistence, LLM stub fill,
or full WIT codegen. Composes patterns from `wrpc-in-process-link-contract` and
`conformance-port-suite-contract` replay traces.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/wit-port-stub-contract test
```

## Executable evidence
- `architecture/` — protobuf + CUE
- `architecture/pacts/` — PACT boundary
