# SLO-Gated Rollback Analysis Contract

This POC proves HOBO-342's per-rollout-step metric-analysis gate for the Harness. It consumes the
existing SLO-gate contract, Golden-suite result, and deployment-strategy saga surfaces without
implementing SLO computation, Golden suites, or rollout strategy internals.

## Contract

- `evaluateRolloutMetricGate(input)` returns a pure `promote | hold | rollback` verdict from
  `(snapshot@seq, Golden-suite result, thresholds, analysis window)`.
- `toRolloutGateSignal(decision)` maps the verdict to the delivery saga gate signal: promote passes,
  rollback fails and triggers rollback, hold stays non-promoting.
- Rollback decisions create an open `policy.ObligationCreated` for `error-budget.auto-revert`.
- `completeRollbackObligation(...)` records `policy.ObligationSatisfied` or
  `policy.ObligationEscalated`, and `replayMetricGateEvents(events)` proves open obligations block.

## Scope

In scope:

- healthy SLO snapshot plus passing Golden suite promotes;
- sustained SLO burn rolls back as an auto-revert obligation;
- continuous Golden-suite failure rolls back;
- stale, unavailable, or missing SLO reads hold instead of promoting;
- flapping burn samples require sustained breach or sustained health before changing terminal state.

Out of scope:

- SLO definition/computation and telemetry ingestion;
- Golden-suite execution;
- strategy-saga implementation beyond consuming the emitted gate signal;
- the HOBO-356 correctness spike's statistical threshold calibration.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\slo-gated-rollback-analysis-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Slo Gated Rollback Analysis Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
