# HOBO-694 Local Dev Orchestration Proof

HOBO-694 is proven by the focused POC at
[`src/draft/technical-proofs/local-dev-orchestration-contract`](../../../../src/draft/technical-proofs/local-dev-orchestration-contract).

## Acceptance Coverage

- Plan 7 inner-loop section names local lifecycle behavior for each annotation class
  from Plan 21 (`bind`, endpoints, env/args, storage, lifetime, explicit startup,
  `waitFor`, `waitForCompletion`, health, replicas, scaling, residency).
- Dependency-gated startup semantics align with Plan 4 choreography (no central
  coordinator; dependents wait on producer **Ready**).
- Executable tests prove `waitFor` + health gates, `waitForCompletion`, explicit
  startup, parallel roots, lazy env resolution, local replica/scaling labels, reverse
  shutdown order, and cycle detection.

## Adversarial Coverage

- Failed health probe leaves dependents waiting (no silent ready).
- Non-zero job exit emits **Start failed** and blocks dependents.
- `withExplicitStartup` does not auto-start without manual start when no `waitFor` targets exist; auto-starts when every `waitFor` target is **Ready**.
- External endpoints surface `external:localhost` on **Ready**.
- Dependency cycles fail at graph build time.

## Scope Guard

The POC explicitly does not implement production `runtime-local`, Docker/Podman
integration, real health probes, the `hobo dev` CLI daemon, or provider-specific
annotations.
