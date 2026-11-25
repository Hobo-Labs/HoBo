# HOBO-17 Runtime-Local Component Host Proof

This proof backs [PLAN-20](../../wasm-runtime-wit.md#plan-20), [ADR-0031](../../adr/01-architecture-core.md#adr-0031), and [ADR-0069](../../adr/01-architecture-core.md#adr-0069).

The branch adds `src/draft/technical-proofs/runtime-local-component-host`, an independent POC for the M1 `runtime-local` `component-host` skeleton. It proves component lifecycle, static import-to-export linking, local HTTP handler invocation, trap isolation, and teardown cleanup without implementing the later cross-process or conformance-suite slices.

**Promotion (S1-02 / HOBO-591):** production implementation lives at `packages/runtimes/runtime-local` (`@hobo/runtime-local`).

## Acceptance Evidence

- `runtime-local host runs an HTTP component through a static in-process link table`
- `link table supports direct in-process import-to-export invocation`
- `component traps fail the call without taking down the host`
- `teardown releases leases and removes routes for unloaded components`
- `host report records HOBO-17 boundaries and fuel epoch follow-up`

## Follow-Up Boundary

Fuel/epoch execution limits are intentionally not implemented here. They need a separate host-resource-limit hardening slice so the runtime can bound guest execution without conflating that work with the component lifecycle and link-table skeleton. The follow-up proof is [HOBO-400 runtime-local execution limits](../hobo-400-runtime-local-execution-limits/index.md).
