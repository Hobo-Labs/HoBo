# HoBo Runtime Primitives POC

> **Promoted to production:** `hobo:runtime@0.1.0` primitive interfaces now ship from [`packages/wit/wit/deps/hobo-runtime/`](../../../../packages/wit/wit/deps/hobo-runtime/) (`@hobo/wit`, HOBO-590).

> **Reference implementation (draft):** TS runtime primitives (`workflow`, `step`, `actor`, `saga`, hooks, timers) live in [`hobo-runtime-ts-primitives/`](../hobo-runtime-ts-primitives/) (HOBO-600); production promotion to `packages/runtime/` follows S1-01/S1-05/S1-06 merge.

This package proves the HOBO-13 `hobo:runtime@0.1.0` primitive contract:

- `workflow`: durable steps, sleep, event emission, hooks, run start.
- `actor`: single-writer state append and actor signal.
- `saga`: event subscription, emission, compensation.
- `agent`: durable agent run, tool call, brokered token handle.
- `command`: aggregate command execution and event append.
- `subscribe`: reactive materialization subscription and snapshot read.

The test gate runs `jco types wit --out-dir generated`, typechecks a no-op
guest stub that imports every generated interface, validates the no-op guest
import fixture, and fails closed when the SDK primitive table drifts from WIT or
a nondeterministic wall-clock/random shape appears in the replay-safe surface.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Runtime Primitives.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
