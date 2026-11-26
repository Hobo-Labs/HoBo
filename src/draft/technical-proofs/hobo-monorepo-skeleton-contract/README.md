# HoBo Monorepo Skeleton Contract

Independent POC for HOBO-1. It models the intended pnpm + Turborepo workspace,
the package tree from `docs/design/architecture.md`, and the first boundary lint
rules without converting the design repository itself into the product monorepo.

**Promotion (S0-01 / HOBO-578):** boundary lint (`validateBoundaryImports`, `detectWorkspaceCycles`, `classifyPackage`) and the workspace-skeleton pact now live in production at `packages/conformance/` with `scripts/check-package-boundaries.mts` enforcing the seven-package scaffold under `packages/*`.

## Proven Behaviors

- Root workspace scripts are pinned: `build`, `typecheck`, `lint`, and `test`.
- The required placeholder packages include `packages/core`, adapter families,
  top-level product surfaces, and `examples/hello-bindle`.
- Changesets and conventional commits are required by the workspace contract.
- Adapter packages fail lint when they import another adapter package.
- Circular workspace dependencies fail the cycle check.

## Commands

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-monorepo-skeleton-contract test
npm.cmd --prefix src\draft\technical-proofs\hobo-monorepo-skeleton-contract run build
npm.cmd --prefix src\draft\technical-proofs\hobo-monorepo-skeleton-contract run typecheck
npm.cmd --prefix src\draft\technical-proofs\hobo-monorepo-skeleton-contract run lint
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Monorepo Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
