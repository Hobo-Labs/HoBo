# Progressive Delivery Harness Simulation

## Running the epic simulation

Command:

```powershell
npm.cmd --prefix src\draft\epic-proofs\progressive-delivery-harness run simulate
```

What this proves:

- Healthy canary promotes through 10%, 50%, and 100% traffic splits.
- SLO burn creates an auto-revert obligation and rolls traffic back.
- Stale rulesets hold release instead of pretending a stale evaluator is fresh.
- Underpowered experiment analysis does not conclude even when delivery promotes.
- Stuck traffic splits and failed rollback compensation escalate to `needs-human`.

Mocked boundaries:

- Feature-flag provider: fixture-backed detailed evaluation.
- Ruleset sync: fixture-backed `seq` and freshness labels.
- Policy gate: fixture-backed allow or obligation response.
- Traffic split provider: fixture-backed requested and observed percentages.
- SLO telemetry: fixture-backed pinned SLO snapshots.
- Experiment analytics: fixture-backed guarded conclusion.
- Event stream: in-memory event append boundary.
- Rollback compensator: fixture-backed satisfied or escalated obligation.

Contracts:

- `contracts/pacts/pact-harness-flag-provider.json`
- `contracts/pacts/pact-harness-ruleset-sync.json`
- `contracts/pacts/pact-harness-policy-gate.json`
- `contracts/pacts/pact-harness-traffic-split.json`
- `contracts/pacts/pact-harness-slo-telemetry.json`
- `contracts/pacts/pact-harness-experiment-analytics.json`
- `contracts/pacts/pact-harness-event-stream.json`
- `contracts/pacts/pact-harness-rollback-compensation.json`
