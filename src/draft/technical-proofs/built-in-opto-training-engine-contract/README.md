# Built-in OPTO Training Engine Contract

Independent POC for HOBO-338. It implements the built-in `training-engine`
optimizer boundary without adding external Agent Lightning / Trace adapters or
persisting promoted candidates.

## Contract Shape

- `createBuiltInOptoTrainingEngine()` exposes the HOBO-317
  `optimize(request)` adapter shape for the built-in OPTO engine id.
- Low-score trajectories are treated as feedback over a trainable generated
  region. The optimizer derives deterministic route rules and emits a candidate
  patch bounded to that region.
- `screenCandidateForPromotion()` runs the candidate through the same hard
  boundary checks: region-scoped patch validation, contract output invariants,
  and held-out rubric improvement.
- `runBuiltInOptoTrainingRun()` emits replayable `training.*` events for the
  proposed and evaluated candidate, but does not promote or persist it.

## Scope Boundary

This package intentionally does not implement external trainer adapters, live
trajectory storage, policy-engine internals, champion/challenger routing, or
the ADR-0048 persisted mutation path.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\built-in-opto-training-engine-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Built In Opto Training Engine Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
