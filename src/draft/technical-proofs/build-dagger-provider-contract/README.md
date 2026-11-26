# HOBO-195 Build Dagger Provider Contract

Independent POC for the `@hobo/build-dagger` container-image fallback
BuildProvider.

This package proves the container fallback seam without implementing real Dagger
execution, registry publication, build-wasm, VM/microVM images, Workload Profile
selection, or BuildMachine host selection.

Acceptance mapping:

- `createBuildDaggerProvider().build(spec)` returns a deterministic OCI
  `ImageRef` for a fixture container `BuildSpec`.
- Rebuilding the same fixture `BuildSpec` produces the same manifest digest
  using a pinned base image digest, canonical source descriptor, canonical
  pipeline descriptor, and content-addressed OCI manifest.
- The emitted `ImageRef` wires back through the fixture provider `IacProgram`
  using `wireBuildOutputs(...)`, and the fixture deploy adapter provisions the
  compute node with that image.
- `runBuildDaggerConformance(...)` gates provider identity, reproducibility,
  caller-supplied IAC wire-back, failure-log events, and target-architecture
  fail-closed behavior.
- A failing build throws `BuildDaggerError` with `exec.Output`-style log events.
- Adversarial guards fail closed for unpinned base images, non-reproducible
  pipeline steps, BuildMachine resource/time budget overruns, and multi-arch
  images missing the requested target architecture.

Run it with:

```powershell
npm.cmd --prefix src/draft/technical-proofs/build-dagger-provider-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Build Dagger Provider Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
