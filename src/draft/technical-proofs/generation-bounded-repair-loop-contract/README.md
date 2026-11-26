# Generation Bounded Repair Loop Contract POC

Independent POC for HOBO-330. It pins the M1 repair-loop contract from the
generation pipeline: failed validation sets are fed back to a bounded
regenerator, successful candidates emit replayable validation evidence, and
exhausted budgets emit one `gen.NeedsHuman` event.

## Contract

- `runBoundedRepairLoop()` consumes a valid HOBO-307 `GenRequest` plus the
  current generated candidate handoff.
- Validation failures emit `gen.ValidationFailed` with the failing assertion set.
- Each repair emits `gen.Repaired` with a 1-based iteration and the exact failing
  set that drove regeneration.
- Exhausting the configured per-run budget emits exactly one `gen.NeedsHuman`
  with `reason: "repair-budget-exhausted"`.
- Request payload fields cannot disable or expand the configured repair budget.
- `replayBoundedRepairRun()` delegates to the generation event replay contract,
  making repair runs rebuildable from the event stream.

## Scope

This POC does not implement optimizer quality, provider/runtime execution,
policy certification, or a real LLM/tool regenerator. The regenerator and
validator are injected test doubles so the contract proves repair-loop bounds,
event shape, and replay behavior.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-bounded-repair-loop-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Bounded Repair Loop Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
