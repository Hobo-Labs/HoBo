# V1 Release Notes Dogfood Alpha Evidence

HOBO-459 proves the M1 dogfood/alpha evidence gate for the V1 Release Notes
and Upgrade Guide project. It extends the HOBO-407 outline contract without
writing final release notes or claiming production upgrade support.

This POC records a machine-checkable M1 gate in
`src/release-notes-dogfood-alpha.ts`:

- `evidence` lists required dogfood/alpha proof and maps each item to an owning
  launch project, release-note section, and v1 cutline blocker category.
- `blockers` and `acceptedRisks` record the known dogfood-only copy risk.
- `deriveDogfoodAlphaFollowUps()` returns follow-up targets only for missing
  evidence.
- `evaluateDogfoodAlphaGate()` reports the accepted-with-risk gate state and the
  parent release-readiness initiative status update required when launch risk
  changes.
- `validateDogfoodAlphaGate()` rejects missing evidence without a follow-up,
  follow-ups for accepted evidence, unsupported evidence states, and missing
  parent status updates when risk changes.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\v1-release-notes-dogfood-alpha-evidence test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the M1 gate.
- `architecture/pacts/` - PACT contract for the gate-read boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
