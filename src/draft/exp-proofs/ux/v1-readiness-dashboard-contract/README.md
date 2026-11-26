# V1 Readiness Dashboard Contract

HOBO-482 defines the release-readiness dashboard fields and source-of-truth rules for the V1
Release Program & Cutline project. This is a design-time contract, not a runtime dashboard
implementation.

This POC records a machine-checkable dashboard contract in `src/v1-readiness-dashboard.ts`:

- `fields` names the seven required dashboard fields: cutline, blockers, milestone health,
  evidence links, accepted risks, owners, and last verified date.
- Each field carries a `sourceOfTruth`, `updateCadence`, `ownerProject`, and explicit empty-state
  semantics.
- Missing evidence is fail-closed and cannot render as green.
- `scope` keeps this slice as a release-evidence aggregate and excludes feature implementation,
  runtime dashboard UI, provider deploy work, legal approval, support tooling, and launch decision
  automation.

Run:

```sh
npm --prefix src/draft/exp-proofs/ux/v1-readiness-dashboard-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for the V1 readiness dashboard record.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
