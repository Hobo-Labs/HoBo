# Local Dev Orchestration Contract

Independent HOBO-694 proof for `hobo dev` local multi-service orchestration.

The contract models dependency-gated startup for the annotation classes pinned in
[Plan 7](../../docs/design/developer-experience.md#the-inner-loop-hobo-dev) without
implementing the runtime-local engine, container engine, or CLI watch loop.

It proves:

- manifest `bind` edges and `waitFor` annotations gate startup order;
- `withHttpHealthCheck` / `withHealthCheck` block `local.Ready` until probe success;
- `waitForCompletion` blocks dependents until a job exits 0;
- `withExplicitStartup` stays stopped until manual start;
- independent roots share an activation wave;
- lazy env refs resolve only after producer `local.Ready`;
- `replicas` / `scaling` collapse to a single local instance with honest labels;
- shutdown order is reverse dependency order;
- dependency cycles fail closed at graph build time.

Run:

```bash
pnpm --prefix src/draft/technical-proofs/local-dev-orchestration-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Local Dev Orchestration Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
