# S1 Stage Gate Draft POC

HOBO-615 proof package wiring the Stage 0/1 gate as an independent draft POC while S1
dependency slices remain in review. Composes existing draft proofs instead of importing
unmerged production packages.

## Gate Definition

> **Stage 0/1:** the local Camp (`runtime-local`) passes runtime-port conformance;
> hello-bindle runs offline; replay == live.

Three checks, fail-closed:

1. **runtime-port-conformance** — `runRuntimePortDurabilitySuite` + `runComponentHostConformance`
   from draft proofs (`hobo.runtime-port-conformance/v1`, `@hobo/conformance/component-host/v1`).
2. **offline-hello-bindle** — boots via `hobo-dev-loop-contract`, drives workflow + actor +
   compensated saga, persists `.hobo/events.jsonl`, cold boot `< 60_000` ms.
3. **replay-equals-live** — `assertReplayEqualsLive` over the persisted log; mutated payload
   raises `ReplayLiveMismatchError`.

## Promotion Target

When S1-04..S1-24 merge, promote this wiring to:

- `examples/hello-bindle/test/s1-stage-gate.*`
- `.github/workflows/s1-stage-gate.yml` (production paths)
- `@hobo/runtime-local` conformance script invocation

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s1-stage-gate run gate:s1
pnpm --prefix src/draft/technical-proofs/s1-stage-gate run gate:s1:offline
pnpm --prefix src/draft/technical-proofs/s1-stage-gate run gate:s1:replay
pnpm --prefix src/draft/technical-proofs/s1-stage-gate run gate:s1:conformance
pnpm --prefix src/draft/technical-proofs/s1-stage-gate run gate:s1:record
```

## Architecture Evidence

- [`architecture/stage_gate_record.proto`](./architecture/stage_gate_record.proto)
- [`architecture/stage_gate_record.cue`](./architecture/stage_gate_record.cue)
- [`ADR.md`](./ADR.md)
