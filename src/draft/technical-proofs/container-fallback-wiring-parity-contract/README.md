# Container Fallback Wiring Parity Contract

Independent POC for HOBO-643. Composes the bind-reference,
hobo-manifest, and secretless-config draft contracts to prove Aspire-style
wiring parity when a service runs as a wasm component or an OCI container
built through `@hobo/build-dagger`.

## Contract surface

- `createMultiCloudShopWiringFixture(runtime)` builds the
  `examples/multi-cloud-shop` api/frontend wiring graph with data binds,
  `${context.*}` config tokens, `ConnectionStrings__*` env, and
  `services__*` endpoint env.
- `projectWiringSurface(manifest, serviceId)` extracts the wiring slice that
  must stay identical across runtime modes.
- `swapRuntimeMode(manifest, runtime)` changes only runtime-specific artifacts
  (`runtime`, `image`, `exports`, `build`).
- `assertWiringParity(left, right, services)` fails closed when bind links,
  env projection, ctx.config tokens (binding, secret-ref, camp-env), or
  `services__*` endpoint env diverge.
- `runContainerFallbackWiringConformance()` gates the multi-cloud-shop fixture
  for component↔container swaps with zero non-runtime manifest edits.

## Proof boundaries

This package does not implement real Dagger builds, provider deploy adapters,
planner ordering, or production promotion to `packages/build/build-dagger`.
It promotes the wiring-parity fixtures from
`src/draft/epic-proofs/sdk-authoring-ifc-bindles/` and
`src/draft/epic-proofs/wit-component-model-runtime-membrane/` as an
executable conformance lane.

## Executable checks

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/container-fallback-wiring-parity-contract
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
