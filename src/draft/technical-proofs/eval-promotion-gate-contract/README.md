# Eval Promotion Gate Contract

Independent POC for HOBO-309. It defines the minimal contract spine that lets
conformance, live evals, and policy compose into one promotion decision without
implementing the scoring runtime or policy engine.

## Contract Shape

- `createClassifyTicketPromotionGate()` returns the `classifyTicket` fixture with
  eval thresholds, shadow traffic, `minSamples`, and the required policy name.
- `validatePromotionGate()` validates the rubric at contract time. The hard
  safety dimension `piiSafe` is mandatory and must be exactly `1`.
- `evaluatePromotionCandidate()` composes three pass flags:
  `conformance`, `eval`, and `policy`. A candidate promotes only when all three
  are true; otherwise it remains in shadow.
- `makeEvalEvent()` and `validateEvalEvent()` define `eval.Ran`,
  `eval.GatePassed`, and `eval.GateFailed` payloads inside the shared telemetry
  envelope shape.

## Scope Boundary

This package is intentionally contract-only. It does not score live evals,
optimize thresholds, route shadow traffic, or evaluate policy rules. Callers pass
those results in as already-observed facts.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\eval-promotion-gate-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Eval Promotion Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
