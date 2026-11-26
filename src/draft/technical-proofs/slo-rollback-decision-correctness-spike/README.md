# SLO Rollback Decision Correctness Spike

Independent HOBO-356 spike proof. This package replays synthetic good, bad, and missing-data rollout
signals through the HOBO-342 metric-analysis decision function and records the threshold recommendation
now captured in [ADR-0104](../../../../docs/design/adr/02-identity-security.md#adr-0104).

## Recommendation

- Use a `15m` analysis window for default SLO-gated rollback decisions.
- Keep rollback at `burnRate >= 12` or `remainingBudgetRatio <= 0.08`.
- Require two sustained breach samples before rollback.
- Require two sustained healthy samples before promotion after a breach.
- Treat missing or stale SLO data as `hold`, never `promote`.

## Evidence

The fixture corpus proves:

- the recommended policy produces `0` false positives and `0` false negatives across the labeled
  good/bad corpus;
- a `5m` window misses the slow-burn bad rollout because only one sample lands inside the window;
- a one-sample tight threshold rolls back a transient blip that the recommended hysteresis holds;
- missing SLO data yields `hold`;
- each verdict carries a stable evidence digest so replay uses pinned inputs.

## Scope

In scope:

- replay fixtures for healthy, fast-burn, slow-burn, transient-blip, and missing-data rollouts;
- FP/FN metrics over labeled fixtures;
- an ADR-style recommendation for window, hysteresis, and thresholds.

Out of scope:

- changing the HOBO-342 decision function;
- production SLO computation;
- Golden-suite execution;
- deployment strategy saga implementation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\slo-rollback-decision-correctness-spike test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Slo Rollback Decision Correctness Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
