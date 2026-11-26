# HOBO-643 Container Fallback Wiring Parity Proof

This proof backs [Plan 21](../../authoring-resources-wiring.md#plan-21) and
Stage 4 item 4 in the archived roadmap.

The executable POC in
[`src/draft/technical-proofs/container-fallback-wiring-parity-contract`](../../../../src/draft/technical-proofs/container-fallback-wiring-parity-contract/README.md)
proves wiring/manifest parity for the OCI-container fallback path:

- bind references, `${context.*}` config tokens, `ConnectionStrings__*`, and
  `services__*` env projection stay identical when `api`/`frontend` swap between
  wasm and `@hobo/build-dagger` container runtime stamps;
- `runContainerFallbackWiringConformance()` gates the
  `examples/multi-cloud-shop` fixture with zero non-runtime manifest edits on
  runtime swap;
- adversarial cases fail closed when container-only env drift, mutated
  `ConnectionStrings__*` keys, or `services__*` endpoint port drift break parity.

Scope kept out: production promotion to `packages/build/build-dagger`, real Dagger
execution, planner/provider deploy adapters, and merged S4-04 mapping styles.
