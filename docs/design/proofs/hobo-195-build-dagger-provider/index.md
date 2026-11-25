# HOBO-195 Build Dagger Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0005](../../adr/01-architecture-core.md#adr-0005).

The executable POC in
[`src/draft/technical-proofs/build-dagger-provider-contract`](../../../../src/draft/technical-proofs/build-dagger-provider-contract/README.md)
proves the M2 `@hobo/build-dagger` container fallback BuildProvider:

- a fixture container `BuildSpec` produces a reproducible OCI `ImageRef` using a
  pinned base image digest and canonical Dagger pipeline descriptor;
- the `ImageRef` feeds back into the fixture provider `IacProgram` and is
  consumed by a fixture deploy adapter;
- the conformance helper gates provider identity, reproducibility, wire-back,
  failing-build `exec.Output` logs, and missing-target-architecture rejection;
- unpinned base images, non-reproducible pipeline steps, BuildMachine
  resource/time budget overruns, and multi-arch target mismatches fail closed
  with precise `BuildDaggerError` codes.

Scope kept out: real Dagger execution, OCI registry publication, build-wasm,
VM/microVM image builds, Workload Profile selection, BuildMachine host routing,
and downstream runtime execution.
