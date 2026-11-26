# Champion/Challenger Promotion Contract (HOBO-344)

This proof package models the source-persistence side of `"use training"` promotion:
shadow traffic runs against a challenger while champion output is served, green gated candidates
promote only through a marked generated region, and production/high-risk promotions return a PR
delta instead of mutating source in place.

## Contract Surface

- `shadowTraffic` duplicates requests to champion and challenger while keeping champion as the
  served response.
- `promote` requires a certified gate result plus signed generation provenance before it can persist
  a candidate.
- Preview/low-risk promotion applies one region-scoped edit and records `training.Promoted` plus
  `impl.Promoted` events with revert snapshots.
- Production/high-risk promotion leaves source unchanged and emits a `source-pr-delta`.
- `checkGeneratedRegionDrift` is the CLI-facing `hobo codegen --check` proof hook for detecting
  drift inside the generated region while preserving visibility into hand-written changes.

## Proven Acceptance

- Passing challenger promotes and touches only the marked generated region; hand-written source stays
  byte-identical.
- Promotion is idempotent and reversible from the append-only promotion log.
- Production promotion emits a PR/Delta rather than auto-applying.
- Out-of-region candidate patches are rejected.
- Incomplete signed provenance is rejected before persistence.

Run the proof with:

```powershell
npm.cmd --prefix src\draft\technical-proofs\champion-challenger-promotion-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Champion Challenger Promotion Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
