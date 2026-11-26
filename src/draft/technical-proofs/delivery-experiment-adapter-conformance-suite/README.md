# Delivery and experiment adapter conformance suite POC

Independent POC for HOBO-387. It pins the shared Harness adapter conformance
suite for `hobo:delivery` and `hobo:experiment` so built-in engines and external
adapters prove the same behavior.

## Scope

- Delivery adapters must pass the identical rollout suite: `rollout.Started` to
  `rollout.Stepped` to `rollout.Promoted`, rollback verdict emission, and
  CDEvents round-trip through the HoBo delivery event envelope.
- Experiment adapters must pass the identical assignment suite: deterministic
  sticky assignment, idempotent exposure recording, and `experiment.Concluded`
  verdict emission.
- Missing delivery capabilities degrade through asserted PlanWarnings instead
  of panicking or self-certifying.
- Camp-level adapter swaps are represented as Matching output over
  `hobo:delivery` and `hobo:experiment`, leaving the app code digest unchanged.
- Negative fixtures prove the suite fails non-conformant rollout CDEvents,
  rollback verdict drops, and experiment rebucketing for an already-assigned
  subject.

## Out of scope

- Implementing every named external adapter.
- Rebuilding the built-in delivery or experiment engines.
- OpenFeature provider conformance; that is a separate flag adapter suite.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\delivery-experiment-adapter-conformance-suite test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Delivery Experiment Adapter Conformance Suite.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
