# Compatibility Matrix Scope Contract POC

Independent POC for HOBO-432. It pins the M0 Compatibility Matrix scope and
acceptance record without implementing browser grids, native mobile support,
live e2e certification, performance testing, or release publication.

## Contract Surface

- `COMPATIBILITY_MATRIX_SCOPE` is versioned as `hobo.compatibility-matrix-scope/v1`.
- Required sections cover user/business goal, primary personas, scope in, scope out, owner
  boundaries, M1 evidence, and follow-up gating.
- Owner boundaries map product, UX, DX/CLI, support/release, security, and privacy responsibilities.
- M1 evidence names matrix fixtures, claim mapping, and unsupported-report routing.
- Validation rejects browser-grid, native-mobile, live-e2e, and proofless follow-up scope creep.

## Scope Boundaries

Included:

- Deterministic M0 compatibility scope fixture and validator.
- Persona, owner-boundary, evidence, and follow-up gate records.
- Scope guards for browser grid, native mobile, and live e2e implementation creep.

Excluded:

- Automated browser grid, device lab, native mobile app, live e2e, performance certification, or
  support tooling implementation.
- Public compatibility guarantees without accepted downstream evidence.
- Replacement of runtime/package compatibility contracts.

## Verification

```powershell
pnpm --dir src/draft/exp-proofs/cx/compatibility-matrix-scope-contract test
pnpm exec oxlint src/draft/exp-proofs/cx/compatibility-matrix-scope-contract --deny-warnings
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Compatibility Matrix Scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
